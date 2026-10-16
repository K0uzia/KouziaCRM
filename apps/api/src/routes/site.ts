import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  Prisma,
  SiteAuthorizationScope,
  SiteFaqPage,
  SiteItemStatus,
  SiteMediaKind,
  SiteProjectKind,
  SitePublicationStatus,
  SiteReferenceType,
  type SiteReference,
  type SiteReview,
} from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional, encryptOptional } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { secretMeta } from "@/lib/settings/secrets.js";
import { httpsUrl, imagePath, SITE_FILES, siteText, slug } from "@/lib/site/contract.js";
import { parseTech } from "@/lib/site/mapping.js";
import { readSiteText, writeSiteText, isSiteTextKey } from "@/lib/site/texts.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { itemHash, pendingChanges, publicationState as itemPublicationState, textHash, type SiteCollection } from "@/lib/site/changes.js";
import { previewPublication, publicationOut, publishSite, PublishError } from "@/lib/site/publish.js";
import { TESTIMONIAL_SOURCE, withdrawalsOnSite } from "@/lib/site/testimonials.js";
import { importSiteFiles, siteContentExists, SiteImportError } from "@/lib/site/import.js";
import { GithubError, readSiteRepoBinary, readSiteRepoFiles, saveGithubToken, siteBranch, siteRepo, testGithubConnection } from "@/lib/site/github.js";
import {
  loadSharp,
  readSiteMedia,
  saveSiteImage,
  siteMediaPublicPath,
  SiteMediaError,
  SITE_MEDIA_MAX_INPUT_BYTES,
} from "@/lib/site/media.js";
import { HistoryError, publicationDetail, restoreVersion } from "@/lib/site/history.js";
import { adoptMissingMedia, deleteLibraryMedia, LibraryError, listLibrary, recropLibraryMedia } from "@/lib/site/library.js";
import { issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";
import { readFile } from "node:fs/promises";

/**
 * Espace « Site » (admin) : contenu de kouzia.com saisi dans l'ERP, puis publié dans le dépôt du site.
 * Toutes les routes exigent la session admin.
 */

const CODE_HOSTS = /^https:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\//;
const optionalText = siteText.nullish();
const status = z.enum(SiteItemStatus).optional();

const projectInput = z.strictObject({
  slug,
  name: siteText,
  subtitle: optionalText,
  // Ligne sous le titre de la carte : vide ou blancs = pas de mention.
  mention: z.preprocess((v) => (typeof v === "string" && !v.trim() ? null : v), siteText.max(60).nullish()),
  kind: z.enum(SiteProjectKind),
  text: siteText.max(400),
  role: optionalText,
  tech: z.array(siteText).max(12).default([]),
  url: httpsUrl.refine((u) => !CODE_HOSTS.test(u), "Lien vers du code source interdit (charte)"),
  linkLabel: siteText.max(40),
  imagePath,
  imageMobilePath: imagePath.nullish(),
  /** null : le site calcule le texte ; "" : capture décorative ; texte : publié tel quel. */
  imageAlt: z.union([z.literal(""), siteText.max(200)]).nullish(),
  status,
});

const reviewInput = z.strictObject({
  author: siteText.max(120),
  reviewedOn: z.iso.date(),
  text: siteText.max(4000),
  rating: z.int().min(1).max(5).nullish(),
  googleUrl: httpsUrl.nullish(),
  consentAt: z.iso.datetime({ offset: true }).nullish(),
  consentChannel: optionalText,
  consentProof: z.string().max(4000).nullish(),
  withdrawalRequestedAt: z.iso.datetime({ offset: true }).nullish(),
  experienceOn: z.iso.date().nullish(),
  clientId: z.string().min(1).max(64).nullish(),
  invoiceId: z.string().min(1).max(64).nullish(),
  alteredWithConsent: z.boolean().default(false),
  status,
});

const referenceInput = z.strictObject({
  slug,
  type: z.enum(SiteReferenceType),
  name: siteText.max(120),
  logoPath: z.string().regex(/^\/media\/[a-f0-9]{12}\.webp$/).nullish(),
  /** Jamais vide : le logo est le nom du lien vers la structure. null : le nom de la structure. */
  logoAlt: siteText.max(120).nullish(),
  url: httpsUrl.nullish(),
  productSlug: slug.nullish(),
  testimonial: z
    .strictObject({ text: siteText.max(1000), author: siteText.max(120), role: optionalText })
    .nullish(),
  authorizationAt: z.iso.datetime({ offset: true }).nullish(),
  authorizationChannel: optionalText,
  authorizationScope: z.enum(SiteAuthorizationScope).nullish(),
  contact: z.string().max(500).nullish(),
  onHome: z.boolean().default(true),
  onProjects: z.boolean().default(false),
  status,
});

const faqInput = z.strictObject({
  page: z.enum(SiteFaqPage),
  question: siteText.max(300),
  answer: siteText.max(2000),
  status,
});

const idParams = z.object({ id: z.string().min(1).max(64) });
const reorderBody = z.strictObject({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) });

type Guarded = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const admin =
  (handler: Guarded): Guarded =>
  async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return handler(request, reply);
  };

const invalid = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ error: "Données invalides", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });

const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));

/** Prisma : doublon d'identifiant publié (slug). */
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

type ReviewRow = SiteReview & { project?: { id: string; name: string } | null; client?: { id: string; displayName: string } | null };

/**
 * Témoignage pour l'écran : preuve déchiffrée pour une saisie manuelle (texte libre) ; pour un témoignage
 * de l'espace client, seuls la version et la date de l'accord sont montrées (IP et navigateur restent chiffrés).
 */
function reviewOutAdmin(r: ReviewRow) {
  const { consentProofEncrypted, ...rest } = r;
  const proof = decryptOptional(consentProofEncrypted);
  if (r.source !== TESTIMONIAL_SOURCE) return { ...rest, consentProof: proof };
  let consentVersion: string | null = null;
  try {
    consentVersion = proof ? ((JSON.parse(proof) as { consentVersion?: string }).consentVersion ?? null) : null;
  } catch {
    consentVersion = null;
  }
  return { ...rest, consentProof: null, consentVersion };
}
function referenceOutAdmin(r: SiteReference) {
  const { contactEncrypted, ...rest } = r;
  return { ...rest, contact: decryptOptional(contactEncrypted) };
}

/**
 * Conditions pour passer un élément en « publié ».
 * Avis (L111-7-2, D111-17 du Code de la consommation ; L121-4 : pas d'avis présenté comme client sans
 * vérification) : accord écrit, client lié (preuve de la relation), date de l'expérience.
 * Référence (mur de logos) : autorisation couvrant ce qui est montré, lien https, au moins un emplacement.
 */
function publishBlocker(kind: "review" | "reference", row: Record<string, unknown>): string | null {
  if (row.status !== SiteItemStatus.PUBLISHED) return null;
  if (kind === "review") {
    if (!row.consentAt) return "Accord de l'auteur requis avant publication.";
    if (row.source !== TESTIMONIAL_SOURCE && !row.consentProofEncrypted) {
      return "Preuve de l'accord requise avant publication (copie du message ou du papier signé).";
    }
    if (row.rejectedAt) return "Témoignage écarté : le publier impose d'annuler l'écartement.";
    if (!row.clientId) return "Client lié requis avant publication : il prouve que l'avis vient d'un vrai client.";
    if (!row.experienceOn) return "Date de l'expérience requise avant publication (affichée près de l'avis).";
    // Charte du site : avis recopiés à l'identique. alteredWithConsent reste en base, toujours false.
    if (row.alteredWithConsent) return "Avis retouché : seul le texte exact de l'auteur est publiable.";
  }
  if (kind === "reference") {
    if (row.type !== SiteReferenceType.USER) {
      if (!row.url) return "Lien vers le site de la structure requis : chaque logo y mène.";
      if (!row.logoPath) return "Logo requis pour le mur de logos.";
      if (!row.onHome && !row.onProjects) return "Choisir au moins un emplacement sur le site.";
    }
    if (!row.authorizationAt || !row.authorizationScope) return "Autorisation requise avant publication.";
    if (row.logoPath && row.authorizationScope === SiteAuthorizationScope.NAME) return "L'autorisation ne couvre pas le logo.";
    if (row.testimonialText && row.authorizationScope !== SiteAuthorizationScope.TESTIMONIAL) {
      return "L'autorisation ne couvre pas le témoignage.";
    }
    if (row.type === SiteReferenceType.USER && !row.productSlug) return "Produit obligatoire pour « Ils l'utilisent ».";
  }
  return null;
}

type Delegate = {
  findMany(args: object): Promise<unknown[]>;
  findUnique(args: { where: { id: string } }): Promise<{ id: string; publishedAt: Date | null } | null>;
  delete(args: { where: { id: string } }): Promise<unknown>;
  update(args: { where: { id: string }; data: { position: number } }): Promise<unknown>;
};

/** Liste, suppression (jamais publié seulement) et ordre : communs aux quatre collections. */
function registerCollectionBasics(
  app: Parameters<FastifyPluginAsync>[0],
  base: string,
  collection: SiteCollection,
  delegate: () => Delegate,
  out: (row: never) => unknown = (row) => row,
  include?: object,
) {
  app.get(
    base,
    admin(async () => {
      const rows = await delegate().findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }], ...(include ? { include } : {}) });
      // État de publication (Brouillon, Nouveau, Modifié, Publié, retrait à publier), calculé sans GitHub.
      return rows.map((r) => ({ ...(out(r as never) as object), publication: itemPublicationState(r as never, itemHash(collection, r as never)) }));
    }),
  );

  app.delete(
    `${base}/:id`,
    admin(async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalid(reply, params.error);
      const row = await delegate().findUnique({ where: { id: params.data.id } });
      if (!row) return reply.code(404).send({ error: "Introuvable" });
      if (row.publishedAt) {
        return reply.code(409).send({ error: "Déjà publié : le retirer (statut « Retiré ») au lieu de le supprimer." });
      }
      await delegate().delete({ where: { id: row.id } });
      return reply.code(204).send();
    }),
  );

  app.post(
    `${base}/reorder`,
    admin(async (request, reply) => {
      const body = reorderBody.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      try {
        await prisma.$transaction(
          body.data.ids.map((id, position) => delegate().update({ where: { id }, data: { position } }) as never),
        );
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") {
          return reply.code(400).send({ error: "Élément inconnu dans l'ordre demandé" });
        }
        throw e;
      }
      return reply.code(204).send();
    }),
  );
}

/**
 * « Modifié, non publié » : l'instantané courant diffère du dernier contenu arrivé dans le dépôt
 * (commit fait, ou NOOP qui prouve que le dépôt était déjà à jour). Sans publication : inconnu (null).
 * live : ce contenu a été vu sur kouzia.com (version.json), et pas seulement enregistré dans le dépôt.
 */
async function publicationState(digest: string) {
  const [last, done, live] = await Promise.all([
    prisma.sitePublication.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.sitePublication.findFirst({
      where: { OR: [{ commitSha: { not: null } }, { status: SitePublicationStatus.NOOP }] },
      orderBy: { startedAt: "desc" },
    }),
    prisma.sitePublication.findFirst({ where: { status: SitePublicationStatus.LIVE, digest }, select: { id: true } }),
  ]);
  return {
    last: last ? publicationOut(last) : null,
    unpublished: done ? done.digest !== digest : null,
    live: done ? done.digest === digest && Boolean(live) : null,
  };
}

const nextPosition = (max: { _max: { position: number | null } }) => (max._max.position ?? -1) + 1;

export const siteRoutes: FastifyPluginAsync = async (app) => {
  // --- État de l'espace Site -------------------------------------------------------------------
  app.get(
    "/api/site/status",
    admin(async () => {
      const settings = await getCompanySettings();
      const [snapshot, withdrawals] = await Promise.all([buildSiteSnapshot(), withdrawalsOnSite()]);
      return {
        imagesAvailable: Boolean(await loadSharp()),
        github: {
          repo: siteRepo(),
          branch: siteBranch(),
          token: secretMeta(settings.githubTokenHint, settings.githubTokenEncrypted),
          expiresAt: settings.githubTokenExpiresAt,
          checkedAt: settings.githubTokenCheckedAt,
        },
        empty: !(await siteContentExists()),
        digest: snapshot.digest,
        publication: await publicationState(snapshot.digest),
        issues: snapshot.issues,
        // Retirés après publication, encore dans avis.json : alerte « Retrait demandé : à publier ».
        withdrawalsOnSite: withdrawals,
      };
    }),
  );

  /**
   * Changements qui partiront à la prochaine publication, calculés sans GitHub : compteur et panneau de la barre du
   * haut. undetailed : le contenu diffère de la dernière publication sans changement identifiable (publication
   * antérieure au suivi par empreinte) ; la prochaine publication rétablit le détail.
   */
  app.get(
    "/api/site/changes",
    admin(async () => {
      const settings = await getCompanySettings();
      const snapshot = await buildSiteSnapshot();
      const [{ changes }, publication] = await Promise.all([pendingChanges(snapshot), publicationState(snapshot.digest)]);
      return {
        changes,
        undetailed: publication.unpublished === true && changes.length === 0,
        unpublished: publication.unpublished,
        live: publication.live,
        last: publication.last,
        issues: snapshot.issues,
        warnings: snapshot.warnings,
        tokenSet: Boolean(settings.githubTokenEncrypted),
      };
    }),
  );

  // --- Réalisations ----------------------------------------------------------------------------
  registerCollectionBasics(app, "/api/site/projects", "projects", () => prisma.siteProject as unknown as Delegate, (p: never) => {
    const row = p as { techJson: string | null };
    return { ...(row as object), tech: parseTech(row.techJson) ?? [] };
  });

  const projectData = (d: z.output<typeof projectInput>) => ({
    slug: d.slug,
    name: d.name,
    subtitle: d.subtitle ?? null,
    mention: d.mention ?? null,
    kind: d.kind,
    text: d.text,
    role: d.role ?? null,
    techJson: d.tech.length ? JSON.stringify(d.tech) : null,
    url: d.url,
    linkLabel: d.linkLabel,
    imagePath: d.imagePath,
    imageMobilePath: d.imageMobilePath ?? null,
    imageAlt: d.imageAlt ?? null,
    ...(d.status ? { status: d.status } : {}),
  });

  app.post(
    "/api/site/projects",
    admin(async (request, reply) => {
      const body = projectInput.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      try {
        const row = await prisma.siteProject.create({
          data: { ...projectData(body.data), position: nextPosition(await prisma.siteProject.aggregate({ _max: { position: true } })) },
        });
        return reply.code(201).send({ ...row, tech: body.data.tech });
      } catch (e) {
        if (isUniqueViolation(e)) return reply.code(409).send({ error: "Identifiant déjà utilisé" });
        throw e;
      }
    }),
  );

  app.put(
    "/api/site/projects/:id",
    admin(async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = projectInput.safeParse(request.body);
      if (!params.success) return invalid(reply, params.error);
      if (!body.success) return invalid(reply, body.error);
      const current = await prisma.siteProject.findUnique({ where: { id: params.data.id } });
      if (!current) return reply.code(404).send({ error: "Introuvable" });
      if (current.publishedAt && current.slug !== body.data.slug) {
        return reply.code(409).send({ error: "Identifiant publié : il ne change plus (le code du site y fait référence)." });
      }
      try {
        const row = await prisma.siteProject.update({ where: { id: current.id }, data: projectData(body.data) });
        return { ...row, tech: body.data.tech };
      } catch (e) {
        if (isUniqueViolation(e)) return reply.code(409).send({ error: "Identifiant déjà utilisé" });
        throw e;
      }
    }),
  );

  // --- Avis ------------------------------------------------------------------------------------
  registerCollectionBasics(app, "/api/site/reviews", "reviews", () => prisma.siteReview as unknown as Delegate, reviewOutAdmin as (r: never) => unknown, {
    project: { select: { id: true, name: true } },
    client: { select: { id: true, displayName: true } },
  });

  const reviewData = (d: z.output<typeof reviewInput>) => ({
    author: d.author,
    reviewedOn: d.reviewedOn,
    text: d.text,
    rating: d.rating ?? null,
    googleUrl: d.googleUrl ?? null,
    consentAt: toDate(d.consentAt) ?? null,
    consentChannel: d.consentChannel ?? null,
    consentProofEncrypted: encryptOptional(d.consentProof),
    withdrawalRequestedAt: toDate(d.withdrawalRequestedAt) ?? null,
    experienceOn: d.experienceOn ?? null,
    clientId: d.clientId ?? null,
    invoiceId: d.invoiceId ?? null,
    alteredWithConsent: d.alteredWithConsent,
    ...(d.status ? { status: d.status } : {}),
  });

  /** Client existant, et facture ou devis émis du même client : sinon 400 (message pour l'écran). */
  async function relationError(d: z.output<typeof reviewInput>): Promise<string | null> {
    if (d.invoiceId && !d.clientId) return "Choisir le client avant la facture ou le devis.";
    if (d.clientId && !(await prisma.client.findUnique({ where: { id: d.clientId }, select: { id: true } }))) {
      return "Client introuvable.";
    }
    if (d.invoiceId) {
      const doc = await prisma.invoice.findUnique({ where: { id: d.invoiceId }, select: { clientId: true, number: true } });
      if (!doc || doc.clientId !== d.clientId || !doc.number) return "Facture ou devis introuvable pour ce client.";
    }
    return null;
  }

  app.post(
    "/api/site/reviews",
    admin(async (request, reply) => {
      const body = reviewInput.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      const relation = await relationError(body.data);
      if (relation) return reply.code(400).send({ error: relation });
      const data = reviewData(body.data);
      const blocker = publishBlocker("review", data);
      if (blocker) return reply.code(400).send({ error: blocker });
      const row = await prisma.siteReview.create({ data: { ...data, position: nextPosition(await prisma.siteReview.aggregate({ _max: { position: true } })) } });
      return reply.code(201).send(reviewOutAdmin(row));
    }),
  );

  app.put(
    "/api/site/reviews/:id",
    admin(async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = reviewInput.safeParse(request.body);
      if (!params.success) return invalid(reply, params.error);
      if (!body.success) return invalid(reply, body.error);
      const current = await prisma.siteReview.findUnique({ where: { id: params.data.id } });
      if (!current) return reply.code(404).send({ error: "Introuvable" });
      const relation = await relationError(body.data);
      if (relation) return reply.code(400).send({ error: relation });
      const data = reviewData(body.data);
      // Témoignage de l'espace client : les mots et le nom choisis par le client ne se modifient pas dans l'ERP.
      if (current.source === TESTIMONIAL_SOURCE) {
        if (data.author !== current.author || data.text !== current.text) {
          return reply.code(409).send({ error: "Témoignage du client : texte et nom ne se modifient pas. Le publier tel quel ou l'écarter." });
        }
        // La preuve vient de l'espace client : jamais remplacée par une saisie.
        data.consentProofEncrypted = current.consentProofEncrypted;
        data.consentAt = current.consentAt;
        data.consentChannel = current.consentChannel;
      }
      // Texte exact de l'avis : figé une fois publié (une correction impose de retirer puis recréer).
      if (
        current.publishedAt &&
        (data.author !== current.author || data.reviewedOn !== current.reviewedOn || data.text !== current.text)
      ) {
        return reply.code(409).send({ error: "Avis publié : auteur, date et texte ne se modifient plus. Le retirer puis le recréer." });
      }
      const blocker = publishBlocker("review", { ...current, ...data });
      if (blocker) return reply.code(400).send({ error: blocker });
      const row = await prisma.siteReview.update({ where: { id: current.id }, data });
      return reviewOutAdmin(row);
    }),
  );

  // Publier tel quel (statut « Sur le site » : inclus à la prochaine publication, texte figé).
  app.post(
    "/api/site/reviews/:id/publish",
    admin(async (request, reply) => {
      const params = idParams.safeParse(request.params);
      if (!params.success) return invalid(reply, params.error);
      const current = await prisma.siteReview.findUnique({ where: { id: params.data.id } });
      if (!current) return reply.code(404).send({ error: "Introuvable" });
      const next = { ...current, status: SiteItemStatus.PUBLISHED, rejectedAt: null };
      const blocker = publishBlocker("review", next);
      if (blocker) return reply.code(400).send({ error: blocker });
      const row = await prisma.siteReview.update({
        where: { id: current.id },
        data: {
          status: SiteItemStatus.PUBLISHED,
          rejectedAt: null,
          rejectionReason: null,
          // Témoignage de l'espace client : publieLe = date de validation (heure de Paris).
          ...(current.source === TESTIMONIAL_SOURCE
            ? { reviewedOn: new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(new Date()) }
            : {}),
        },
      });
      return reviewOutAdmin(row);
    }),
  );

  /**
   * Écarter (hors sujet, injurieux, données personnelles), motif obligatoire. Renvoie un mailto: neutre pour
   * prévenir l'auteur (D111-19), qui ne cite jamais le témoignage ; null si le client n'a pas d'e-mail.
   */
  app.post(
    "/api/site/reviews/:id/reject",
    admin(async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = z.strictObject({ reason: siteText.min(3).max(500) }).safeParse(request.body);
      if (!params.success) return invalid(reply, params.error);
      if (!body.success) return invalid(reply, body.error);
      const current = await prisma.siteReview.findUnique({ where: { id: params.data.id }, include: { client: true } });
      if (!current) return reply.code(404).send({ error: "Introuvable" });
      if (current.publishedAt) {
        return reply.code(409).send({ error: "Déjà publié : le retirer du site plutôt que l'écarter." });
      }
      const row = await prisma.siteReview.update({
        where: { id: current.id },
        data: { rejectedAt: new Date(), rejectionReason: body.data.reason, status: SiteItemStatus.DRAFT },
      });
      const email = current.client ? decryptOptional(current.client.emailEncrypted) : null;
      const settings = await getCompanySettings();
      const brand = settings.tradeName ?? settings.legalName;
      const mailto = email
        ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Votre témoignage pour ${brand}`)}&body=${encodeURIComponent(
            [
              "Bonjour,",
              "",
              `Merci d'avoir pris le temps de laisser un témoignage. Je ne peux pas le publier sur le site, pour la raison suivante : ${body.data.reason}`,
              "",
              "Vous pouvez en déposer un nouveau depuis votre espace client, ou me répondre si vous avez une question.",
              "",
              "Bien cordialement,",
              brand,
            ].join("\n"),
          )}`
        : null;
      return { review: reviewOutAdmin(row), mailto };
    }),
  );

  // --- Références -------------------------------------------------------------------------------
  registerCollectionBasics(
    app,
    "/api/site/references",
    "references",
    () => prisma.siteReference as unknown as Delegate,
    referenceOutAdmin as (r: never) => unknown,
  );

  const referenceData = (d: z.output<typeof referenceInput>) => ({
    slug: d.slug,
    type: d.type,
    name: d.name,
    logoPath: d.logoPath ?? null,
    logoAlt: d.logoAlt ?? null,
    url: d.url ?? null,
    productSlug: d.productSlug ?? null,
    testimonialText: d.testimonial?.text ?? null,
    testimonialAuthor: d.testimonial?.author ?? null,
    testimonialRole: d.testimonial?.role ?? null,
    authorizationAt: toDate(d.authorizationAt) ?? null,
    authorizationChannel: d.authorizationChannel ?? null,
    authorizationScope: d.authorizationScope ?? null,
    contactEncrypted: encryptOptional(d.contact),
    onHome: d.onHome,
    onProjects: d.onProjects,
    ...(d.status ? { status: d.status } : {}),
  });

  app.post(
    "/api/site/references",
    admin(async (request, reply) => {
      const body = referenceInput.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      const data = referenceData(body.data);
      const blocker = publishBlocker("reference", data);
      if (blocker) return reply.code(400).send({ error: blocker });
      try {
        const row = await prisma.siteReference.create({
          data: { ...data, position: nextPosition(await prisma.siteReference.aggregate({ _max: { position: true } })) },
        });
        return reply.code(201).send(referenceOutAdmin(row));
      } catch (e) {
        if (isUniqueViolation(e)) return reply.code(409).send({ error: "Identifiant déjà utilisé" });
        throw e;
      }
    }),
  );

  app.put(
    "/api/site/references/:id",
    admin(async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = referenceInput.safeParse(request.body);
      if (!params.success) return invalid(reply, params.error);
      if (!body.success) return invalid(reply, body.error);
      const current = await prisma.siteReference.findUnique({ where: { id: params.data.id } });
      if (!current) return reply.code(404).send({ error: "Introuvable" });
      const data = referenceData(body.data);
      const blocker = publishBlocker("reference", { ...current, ...data });
      if (blocker) return reply.code(400).send({ error: blocker });
      try {
        const row = await prisma.siteReference.update({ where: { id: current.id }, data });
        return referenceOutAdmin(row);
      } catch (e) {
        if (isUniqueViolation(e)) return reply.code(409).send({ error: "Identifiant déjà utilisé" });
        throw e;
      }
    }),
  );

  // --- FAQ -------------------------------------------------------------------------------------
  registerCollectionBasics(app, "/api/site/faq", "faq", () => prisma.siteFaq as unknown as Delegate);

  app.post(
    "/api/site/faq",
    admin(async (request, reply) => {
      const body = faqInput.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      const row = await prisma.siteFaq.create({
        data: { ...body.data, status: body.data.status ?? SiteItemStatus.DRAFT, position: nextPosition(await prisma.siteFaq.aggregate({ _max: { position: true } })) },
      });
      return reply.code(201).send(row);
    }),
  );

  app.put(
    "/api/site/faq/:id",
    admin(async (request, reply) => {
      const params = idParams.safeParse(request.params);
      const body = faqInput.safeParse(request.body);
      if (!params.success) return invalid(reply, params.error);
      if (!body.success) return invalid(reply, body.error);
      const current = await prisma.siteFaq.findUnique({ where: { id: params.data.id } });
      if (!current) return reply.code(404).send({ error: "Introuvable" });
      const { status: next, ...rest } = body.data;
      return prisma.siteFaq.update({ where: { id: current.id }, data: { ...rest, ...(next ? { status: next } : {}) } });
    }),
  );

  // --- Coordonnées, accroche, offres ------------------------------------------------------------
  app.get(
    "/api/site/texts",
    admin(async () => {
      const rows = await prisma.siteText.findMany();
      const publication = Object.fromEntries(
        rows.map((t) => [t.key, t.publishedHash && t.publishedHash !== textHash(t.valueJson) ? "modified" : t.publishedHash ? "published" : "unknown"]),
      );
      return {
        infos: await readSiteText("infos"),
        accroche: await readSiteText("accroche"),
        offres: await readSiteText("offres"),
        avisMethode: await readSiteText("avisMethode"),
        publication,
      };
    }),
  );

  app.put(
    "/api/site/texts/:key",
    admin(async (request, reply) => {
      const { key } = request.params as { key: string };
      if (!isSiteTextKey(key)) return reply.code(404).send({ error: "Introuvable" });
      try {
        return await writeSiteText(key, request.body);
      } catch (e) {
        if (e instanceof z.ZodError) return invalid(reply, e);
        throw e;
      }
    }),
  );

  // --- Images ----------------------------------------------------------------------------------
  app.get(
    "/api/site/media",
    admin(async () => {
      return listLibrary();
    }),
  );

  app.post(
    "/api/site/media",
    admin(async (request, reply) => {
      const kind = z.enum(SiteMediaKind).safeParse((request.query as { kind?: string }).kind);
      if (!kind.success) return reply.code(400).send({ error: "Type d'image attendu : CAPTURE, MOBILE ou LOGO" });
      // Un fichier refusé par sharp ou par le contrôle SVG garde son message (400), jamais une 500.
      if (!(await loadSharp())) {
        return reply.code(503).send({ error: "Envoi d'images indisponible : sharp n'est pas installé sur ce serveur." });
      }
      let input: Buffer;
      let filename: string | null = null;
      try {
        const file = await request.file({ limits: { fileSize: SITE_MEDIA_MAX_INPUT_BYTES, files: 1 } });
        if (!file) return reply.code(400).send({ error: "Fichier manquant" });
        filename = file.filename || null;
        input = await file.toBuffer();
      } catch (e) {
        if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "Image trop volumineuse (15 Mo au plus)." });
        }
        throw e;
      }
      try {
        const media = await saveSiteImage(input, kind.data, filename);
        return reply.code(201).send({ ...media, path: siteMediaPublicPath(media.sha12) });
      } catch (e) {
        if (e instanceof SiteMediaError) return reply.code(e.code === "UNAVAILABLE" ? 503 : 400).send({ error: e.message, code: e.code });
        throw e;
      }
    }),
  );

  const mediaId = (request: FastifyRequest) => z.string().min(1).max(64).parse((request.params as { id: string }).id);
  const libraryError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof LibraryError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof SiteMediaError) return reply.code(e.code === "UNAVAILABLE" ? 503 : 400).send({ error: e.message, code: e.code });
    throw e;
  };

  // Nom lisible dans la médiathèque (jamais publié).
  app.patch(
    "/api/site/media/:id",
    admin(async (request, reply) => {
      const body = z.strictObject({ label: z.string().trim().max(120).nullable() }).safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      const media = await prisma.siteMedia.findUnique({ where: { id: mediaId(request) } });
      if (!media) return reply.code(404).send({ error: "Image introuvable" });
      return prisma.siteMedia.update({ where: { id: media.id }, data: { label: body.data.label || null } });
    }),
  );

  // Recadrage autour d'un point d'intérêt (0 à 1) : nouvelle version, fiches repointées.
  app.post(
    "/api/site/media/:id/recadrage",
    admin(async (request, reply) => {
      const body = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      try {
        const media = await recropLibraryMedia(mediaId(request), body.data);
        return { ...media, path: siteMediaPublicPath(media.sha12) };
      } catch (e) {
        return libraryError(reply, e);
      }
    }),
  );

  app.delete(
    "/api/site/media/:id",
    admin(async (request, reply) => {
      try {
        await deleteLibraryMedia(mediaId(request));
        return reply.code(204).send();
      } catch (e) {
        return libraryError(reply, e);
      }
    }),
  );

  // Original conservé (sans métadonnées), pour choisir le point d'intérêt. Logos SVG exclus : pas de recadrage.
  app.get(
    "/api/site/media/:id/original",
    admin(async (request, reply) => {
      const media = await prisma.siteMedia.findUnique({ where: { id: mediaId(request) } });
      const type = /.(jpg|png|webp)$/.exec(media?.originalPath ?? "")?.[1];
      const buf = media?.originalPath && type ? await readFile(issuedPdfAbsolutePath(media.originalPath)).catch(() => null) : null;
      if (!buf) return reply.code(404).send({ error: "Introuvable" });
      return reply
        .type(type === "jpg" ? "image/jpeg" : `image/${type}`)
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .send(buf);
    }),
  );

  app.get(
    "/api/site/media/:file",
    admin(async (request, reply) => {
      const m = /^([a-f0-9]{12})(-2x)?\.webp$/.exec((request.params as { file: string }).file);
      const buf = m ? await readSiteMedia(m[1], Boolean(m[2])) : null;
      if (!buf) return reply.code(404).send({ error: "Introuvable" });
      return reply.type("image/webp").header("Cache-Control", "private, max-age=31536000, immutable").send(buf);
    }),
  );

  // --- Dépôt du site (GitHub) -------------------------------------------------------------------
  app.put(
    "/api/site/github",
    admin(async (request, reply) => {
      const body = z.strictObject({ token: z.string().trim().max(400).nullable() }).safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      if (body.data.token && !/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(body.data.token)) {
        return reply.code(400).send({ error: "Jeton GitHub attendu (github_pat_…)." });
      }
      await saveGithubToken(body.data.token);
      const settings = await getCompanySettings();
      return { token: secretMeta(settings.githubTokenHint, settings.githubTokenEncrypted) };
    }),
  );

  app.post(
    "/api/site/github/test",
    admin(async (_request, reply) => {
      try {
        return await testGithubConnection();
      } catch (e) {
        if (e instanceof GithubError) return reply.code(e.status === 412 ? 412 : 502).send({ error: e.message });
        throw e;
      }
    }),
  );

  // --- Reprise initiale du contenu du site ------------------------------------------------------
  app.post(
    "/api/site/import",
    admin(async (_request, reply) => {
      if (await siteContentExists()) {
        return reply.code(409).send({ error: "L'espace Site contient déjà du contenu : import refusé." });
      }
      try {
        const { files } = await readSiteRepoFiles();
        await importSiteFiles(files);
        // Images déjà publiées : copiées depuis le dépôt, sinon « Image absente de l'ERP » bloquerait la publication.
        await adoptMissingMedia(readSiteRepoBinary).catch((e) => {
          console.error("[site] Reprise des images publiées incomplète :", e instanceof Error ? e.message : e);
        });
      } catch (e) {
        if (e instanceof GithubError) return reply.code(e.status === 412 ? 412 : 502).send({ error: e.message });
        if (e instanceof SiteImportError) {
          return reply.code(e.code === "NOT_EMPTY" ? 409 : 422).send({ error: e.message, details: e.details });
        }
        throw e;
      }
      const snapshot = await buildSiteSnapshot();
      return { digest: snapshot.digest, issues: snapshot.issues };
    }),
  );

  // --- Publication vers le dépôt du site (lot E3) -----------------------------------------------
  const publishFailure = (reply: FastifyReply, e: unknown) => {
    if (e instanceof PublishError) return reply.code(e.status).send({ error: e.message, issues: e.issues });
    if (e instanceof GithubError) return reply.code(e.status === 412 ? 412 : 502).send({ error: e.message });
    throw e;
  };

  app.get(
    "/api/site/publications",
    admin(async () => {
      const rows = await prisma.sitePublication.findMany({ orderBy: { startedAt: "desc" }, take: 20 });
      return rows.map(publicationOut);
    }),
  );

  // --- Historique : changements d'une publication, restauration d'une version dans l'ERP -------------------
  const historyError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof HistoryError) return reply.code(e.status).send({ error: e.message });
    throw e;
  };
  const publicationId = (request: FastifyRequest) => z.string().min(1).max(64).parse((request.params as { id: string }).id);

  app.get(
    "/api/site/publications/:id/detail",
    admin(async (request, reply) => {
      try {
        return await publicationDetail(publicationId(request));
      } catch (e) {
        return historyError(reply, e);
      }
    }),
  );

  app.post(
    "/api/site/publications/:id/restore",
    admin(async (request, reply) => {
      const body = z
        .strictObject({ file: z.enum(SITE_FILES), key: z.string().min(1).max(600), side: z.enum(["after", "before"]) })
        .safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
      try {
        return await restoreVersion(publicationId(request), body.data.file, body.data.key, body.data.side);
      } catch (e) {
        return historyError(reply, e);
      }
    }),
  );

  app.get(
    "/api/site/publish/preview",
    admin(async (_request, reply) => {
      try {
        return await previewPublication();
      } catch (e) {
        return publishFailure(reply, e);
      }
    }),
  );

  app.post(
    "/api/site/publish",
    admin(async (_request, reply) => {
      try {
        return publicationOut(await publishSite());
      } catch (e) {
        return publishFailure(reply, e);
      }
    }),
  );
};
