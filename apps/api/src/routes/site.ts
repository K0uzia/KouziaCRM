import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  Prisma,
  SiteAuthorizationScope,
  SiteFaqPage,
  SiteItemStatus,
  SiteMediaKind,
  SiteProjectKind,
  SiteReferenceType,
  type SiteReference,
  type SiteReview,
} from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional, encryptOptional } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { secretMeta } from "@/lib/settings/secrets.js";
import { httpsUrl, imagePath, siteText, slug } from "@/lib/site/contract.js";
import { parseTech } from "@/lib/site/mapping.js";
import { readSiteText, writeSiteText, isSiteTextKey } from "@/lib/site/texts.js";
import { buildSiteSnapshot } from "@/lib/site/snapshot.js";
import { importSiteFiles, siteContentExists, SiteImportError } from "@/lib/site/import.js";
import { GithubError, readSiteRepoFiles, saveGithubToken, siteBranch, siteRepo, testGithubConnection } from "@/lib/site/github.js";
import {
  loadSharp,
  readSiteMedia,
  saveSiteImage,
  siteMediaPublicPath,
  SiteMediaError,
  SITE_MEDIA_MAX_INPUT_BYTES,
} from "@/lib/site/media.js";

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
  kind: z.enum(SiteProjectKind),
  text: siteText.max(400),
  role: optionalText,
  tech: z.array(siteText).max(12).default([]),
  url: httpsUrl.refine((u) => !CODE_HOSTS.test(u), "Lien vers du code source interdit (charte)"),
  linkLabel: siteText.max(40),
  imagePath,
  imageMobilePath: imagePath.nullish(),
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
  status,
});

const referenceInput = z.strictObject({
  slug,
  type: z.enum(SiteReferenceType),
  name: siteText.max(120),
  logoPath: z.string().regex(/^\/media\/[a-f0-9]{12}\.webp$/).nullish(),
  url: httpsUrl.nullish(),
  productSlug: slug.nullish(),
  testimonial: z
    .strictObject({ text: siteText.max(1000), author: siteText.max(120), role: optionalText })
    .nullish(),
  authorizationAt: z.iso.datetime({ offset: true }).nullish(),
  authorizationChannel: optionalText,
  authorizationScope: z.enum(SiteAuthorizationScope).nullish(),
  contact: z.string().max(500).nullish(),
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

function reviewOutAdmin(r: SiteReview) {
  const { consentProofEncrypted, ...rest } = r;
  return { ...rest, consentProof: decryptOptional(consentProofEncrypted) };
}
function referenceOutAdmin(r: SiteReference) {
  const { contactEncrypted, ...rest } = r;
  return { ...rest, contact: decryptOptional(contactEncrypted) };
}

/** Accord ou autorisation exigés avant de passer un élément en « publié ». */
function publishBlocker(kind: "review" | "reference", row: Record<string, unknown>): string | null {
  if (row.status !== SiteItemStatus.PUBLISHED) return null;
  if (kind === "review" && !row.consentAt) return "Accord de l'auteur requis avant publication.";
  if (kind === "reference") {
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
  delegate: () => Delegate,
  out: (row: never) => unknown = (row) => row,
) {
  app.get(
    base,
    admin(async () => {
      const rows = await delegate().findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
      return rows.map((r) => out(r as never));
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

const nextPosition = (max: { _max: { position: number | null } }) => (max._max.position ?? -1) + 1;

export const siteRoutes: FastifyPluginAsync = async (app) => {
  // --- État de l'espace Site -------------------------------------------------------------------
  app.get(
    "/api/site/status",
    admin(async () => {
      const settings = await getCompanySettings();
      const snapshot = await buildSiteSnapshot();
      return {
        imagesAvailable: Boolean(await loadSharp()),
        github: {
          repo: siteRepo(),
          branch: siteBranch(),
          token: secretMeta(settings.githubTokenHint, settings.githubTokenEncrypted),
          expiresAt: settings.githubTokenExpiresAt,
        },
        empty: !(await siteContentExists()),
        digest: snapshot.digest,
        issues: snapshot.issues,
      };
    }),
  );

  // --- Réalisations ----------------------------------------------------------------------------
  registerCollectionBasics(app, "/api/site/projects", () => prisma.siteProject as unknown as Delegate, (p: never) => {
    const row = p as { techJson: string | null };
    return { ...(row as object), tech: parseTech(row.techJson) ?? [] };
  });

  const projectData = (d: z.output<typeof projectInput>) => ({
    slug: d.slug,
    name: d.name,
    subtitle: d.subtitle ?? null,
    kind: d.kind,
    text: d.text,
    role: d.role ?? null,
    techJson: d.tech.length ? JSON.stringify(d.tech) : null,
    url: d.url,
    linkLabel: d.linkLabel,
    imagePath: d.imagePath,
    imageMobilePath: d.imageMobilePath ?? null,
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
  registerCollectionBasics(app, "/api/site/reviews", () => prisma.siteReview as unknown as Delegate, reviewOutAdmin as (r: never) => unknown);

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
    ...(d.status ? { status: d.status } : {}),
  });

  app.post(
    "/api/site/reviews",
    admin(async (request, reply) => {
      const body = reviewInput.safeParse(request.body);
      if (!body.success) return invalid(reply, body.error);
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
      const data = reviewData(body.data);
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

  // --- Références -------------------------------------------------------------------------------
  registerCollectionBasics(
    app,
    "/api/site/references",
    () => prisma.siteReference as unknown as Delegate,
    referenceOutAdmin as (r: never) => unknown,
  );

  const referenceData = (d: z.output<typeof referenceInput>) => ({
    slug: d.slug,
    type: d.type,
    name: d.name,
    logoPath: d.logoPath ?? null,
    url: d.url ?? null,
    productSlug: d.productSlug ?? null,
    testimonialText: d.testimonial?.text ?? null,
    testimonialAuthor: d.testimonial?.author ?? null,
    testimonialRole: d.testimonial?.role ?? null,
    authorizationAt: toDate(d.authorizationAt) ?? null,
    authorizationChannel: d.authorizationChannel ?? null,
    authorizationScope: d.authorizationScope ?? null,
    contactEncrypted: encryptOptional(d.contact),
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
  registerCollectionBasics(app, "/api/site/faq", () => prisma.siteFaq as unknown as Delegate);

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
    admin(async () => ({
      infos: await readSiteText("infos"),
      accroche: await readSiteText("accroche"),
      offres: await readSiteText("offres"),
    })),
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
      const rows = await prisma.siteMedia.findMany({ orderBy: { createdAt: "desc" } });
      return rows.map((m) => ({ ...m, path: siteMediaPublicPath(m.sha12) }));
    }),
  );

  app.post(
    "/api/site/media",
    admin(async (request, reply) => {
      const kind = z.enum(SiteMediaKind).safeParse((request.query as { kind?: string }).kind);
      if (!kind.success) return reply.code(400).send({ error: "Type d'image attendu : CAPTURE, MOBILE ou LOGO" });
      if (!(await loadSharp())) {
        return reply.code(503).send({ error: "Envoi d'images indisponible : sharp n'est pas installé sur ce serveur." });
      }
      let input: Buffer;
      try {
        const file = await request.file({ limits: { fileSize: SITE_MEDIA_MAX_INPUT_BYTES, files: 1 } });
        if (!file) return reply.code(400).send({ error: "Fichier manquant" });
        input = await file.toBuffer();
      } catch (e) {
        if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "Image trop volumineuse (15 Mo au plus)." });
        }
        throw e;
      }
      try {
        const media = await saveSiteImage(input, kind.data);
        return reply.code(201).send({ ...media, path: siteMediaPublicPath(media.sha12) });
      } catch (e) {
        if (e instanceof SiteMediaError) return reply.code(e.code === "UNAVAILABLE" ? 503 : 400).send({ error: e.message, code: e.code });
        throw e;
      }
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
};
