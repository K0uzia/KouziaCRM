import { createHash } from "node:crypto";
import { SiteAuthorizationScope, SiteItemStatus, SiteReferenceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import {
  contractOptionalFiles,
  SITE_FILES,
  SITE_OPTIONAL_FILES,
  SITE_PAGE_IDS,
  SITE_PAGE_LABEL,
  SITE_SCHEMA_VERSION,
  serializeSiteFile,
  validateOptionalSiteFiles,
  validateSiteFiles,
  type SiteAnyFileName,
  type SiteFileName,
  type SiteIssue,
  type SiteOptionalFileName,
} from "@/lib/site/contract.js";
import { defaultsFromContract, finalSeoIssues, textVariables } from "@/lib/site/seo-menus.js";
import { concernsClient, detailBlocker, detailOut, detailStarted, faqOut, projectOut, referenceOut, reviewOut, VIEW_LABEL } from "@/lib/site/mapping.js";
import { readSiteText } from "@/lib/site/texts.js";
import { SITE_MEDIA_PATH_RE, type SiteMediaExt } from "@/lib/site/media.js";

export type SiteSnapshot = {
  /** Contenu des fichiers src/content/site/<nom>.json, prêt à écrire. Facultatifs : présents seulement s'ils partent. */
  files: Record<SiteFileName, string> & Partial<Record<SiteOptionalFileName, string>>;
  /** Images de l'ERP citées (sha12) : à publier sous public/media/. */
  media: string[];
  /** Ce que montre chaque image citée (sha12), pour le récapitulatif : « capture de « Nom » », « logo de « Nom » ». */
  mediaNames: Record<string, string>;
  /** Extension publiée de chaque image citée (sha12) : webp, ou jpg pour une image de partage. */
  mediaExt: Record<string, SiteMediaExt>;
  /** Empreinte de l'ensemble : deux instantanés égaux ne donnent aucun commit. */
  digest: string;
  issues: SiteIssue[];
  /** Alertes : à vérifier, sans jamais empêcher la publication. */
  warnings: SiteIssue[];
};

const published = { status: SiteItemStatus.PUBLISHED };
const ordered = [{ position: "asc" as const }, { createdAt: "asc" as const }];

/**
 * Instantané du contenu publié (éléments PUBLISHED seulement), validé par les règles de l'ERP et, si
 * fourni, par contenu.schema.json du dépôt. Les accords manquants bloquent la publication.
 * Fichiers facultatifs (pages, seo, menus) : écrits si leur document existe et, contrat fourni, s'il les déclare ; sans
 * contrat (état de l'espace Site), ils figurent dès que leur document existe.
 */
export async function buildSiteSnapshot(contract?: unknown): Promise<SiteSnapshot> {
  const [allProjects, reviews, references, faq, infos, accroche, offres, avisMethode, pages, seo, menus, espaceClient] = await Promise.all([
    prisma.siteProject.findMany({ where: published, orderBy: ordered }),
    // Classement annoncé dans la méthode (D111-17) : du plus récent au plus ancien.
    // Écartés : jamais publiés, même marqués « Sur le site ».
    prisma.siteReview.findMany({ where: { ...published, rejectedAt: null }, orderBy: [{ reviewedOn: "desc" }, ...ordered] }),
    prisma.siteReference.findMany({ where: published, orderBy: ordered }),
    prisma.siteFaq.findMany({ where: published, orderBy: ordered }),
    readSiteText("infos"),
    readSiteText("accroche"),
    readSiteText("offres"),
    readSiteText("avisMethode"),
    readSiteText("pages"),
    readSiteText("seo"),
    readSiteText("menus"),
    readSiteText("espace-client"),
  ]);

  const issues: SiteIssue[] = [];
  const warnings: SiteIssue[] = [];
  // Réalisation liée à un client, jamais publiée, sans son accord écrit : la carte ne part pas (zéro fiction). Une carte
  // déjà en ligne reste publiée ; seule sa page projet attend l'accord.
  const projects = allProjects.filter((p) => {
    const held = concernsClient(p) && !p.publicationConsentAt && !p.publishedAt;
    if (held) warnings.push({ file: "realisations", path: p.name, message: "non publiée : accord écrit du client à renseigner" });
    return !held;
  });
  for (const p of projects) {
    const blocker = detailStarted(p) ? detailBlocker(p) : null;
    if (blocker) warnings.push({ file: "realisations", path: p.name, message: `page projet non publiée : ${blocker}` });
  }
  for (const r of reviews) {
    if (!r.consentAt) issues.push({ file: "avis", path: r.author, message: "Accord de l'auteur non renseigné" });
    if (!r.clientId) issues.push({ file: "avis", path: r.author, message: "Client non lié (preuve de la relation client)" });
    if (!r.experienceOn) issues.push({ file: "avis", path: r.author, message: "Date de l'expérience non renseignée" });
    if (r.alteredWithConsent) issues.push({ file: "avis", path: r.author, message: "Avis retouché : seul le texte exact de l'auteur est publiable" });
  }
  for (const r of references) {
    if (!r.authorizationAt || !r.authorizationScope) {
      issues.push({ file: "references", path: r.slug, message: "Autorisation non renseignée" });
    } else {
      if (r.logoPath && r.authorizationScope === SiteAuthorizationScope.NAME) {
        issues.push({ file: "references", path: r.slug, message: "Logo publié sans autorisation pour le logo" });
      }
      if (r.testimonialText && r.authorizationScope !== SiteAuthorizationScope.TESTIMONIAL) {
        issues.push({ file: "references", path: r.slug, message: "Témoignage publié sans autorisation pour le témoignage" });
      }
    }
  }

  const values: Record<SiteFileName, unknown> = {
    infos: { schemaVersion: SITE_SCHEMA_VERSION, infos },
    textes: { schemaVersion: SITE_SCHEMA_VERSION, accroche, offres },
    faq: { schemaVersion: SITE_SCHEMA_VERSION, questions: faq.map(faqOut) },
    realisations: { schemaVersion: SITE_SCHEMA_VERSION, realisations: projects.map((p) => projectOut(p)) },
    avis: { schemaVersion: SITE_SCHEMA_VERSION, ...(avisMethode ? { methode: avisMethode } : {}), avis: reviews.map(reviewOut) },
    references: { schemaVersion: SITE_SCHEMA_VERSION, references: references.map(referenceOut) },
  };
  if (!infos) issues.push({ file: "infos", path: "infos", message: "Coordonnées non renseignées" });
  if (!accroche || !offres) issues.push({ file: "textes", path: "(racine)", message: "Accroche ou offres non renseignées" });
  issues.push(...validateSiteFiles(values, contract));

  const allowed: Set<SiteOptionalFileName> = contract === undefined ? new Set(SITE_OPTIONAL_FILES) : contractOptionalFiles(contract);
  const optional: Partial<Record<SiteOptionalFileName, unknown>> = {};
  // Document entier (sans schemaVersion) : un bloc ajouté par le site (communs, nouvelle page) part aussi.
  if (pages && allowed.has("pages")) optional.pages = { schemaVersion: SITE_SCHEMA_VERSION, ...pages };
  if (seo && allowed.has("seo")) optional.seo = { schemaVersion: SITE_SCHEMA_VERSION, ...seo };
  if (menus && allowed.has("menus")) optional.menus = { schemaVersion: SITE_SCHEMA_VERSION, ...menus };
  if (espaceClient && allowed.has("espace-client")) optional["espace-client"] = { schemaVersion: SITE_SCHEMA_VERSION, ...espaceClient };
  issues.push(...validateOptionalSiteFiles(optional, contract));
  if (contract === undefined) {
    for (const name of SITE_OPTIONAL_FILES) {
      if (optional[name] !== undefined) {
        warnings.push({ file: name, path: "(racine)", message: "non vérifié : contrat du site illisible (GitHub), vérifié à la publication" });
      }
    }
  }
  // Contrôles du build du site sur les valeurs finales (variables remplacées, valeurs actuelles comprises), dès que le
  // site les applique : même sans seo.json, un délai de réponse plus long peut faire dépasser une description actuelle.
  if (contract !== undefined && allowed.has("seo")) {
    const defaults = defaultsFromContract(contract);
    const vars = await textVariables(defaults?.variables?.ville);
    if (!defaults) issues.push({ file: "seo", path: "(racine)", message: "Contrat du site sans valeurs actuelles (defauts) : impossible de vérifier les descriptions" });
    else if (vars) issues.push(...finalSeoIssues(optional.seo ? seo : null, defaults, vars));
  }

  const projectSlugs = new Set(projects.map((p) => p.slug));
  for (const r of references) {
    if (r.productSlug && !projectSlugs.has(r.productSlug)) {
      const what = r.type === SiteReferenceType.USER ? "Produit" : "Réalisation liée";
      issues.push({ file: "references", path: r.slug, message: `${what} « ${r.productSlug} » absent des réalisations publiées` });
    }
    // Mur de logos : chaque logo mène au site de la structure et paraît au moins à un emplacement.
    if (r.type !== SiteReferenceType.USER) {
      if (!r.url) issues.push({ file: "references", path: r.slug, message: "Lien vers le site de la structure manquant" });
      if (!r.logoPath) issues.push({ file: "references", path: r.slug, message: "Logo manquant" });
      if (!r.onHome && !r.onProjects) issues.push({ file: "references", path: r.slug, message: "Aucun emplacement choisi" });
      // Sur les pages Sites web et Logiciels, une référence paraît d'elle-même par la réalisation liée (KouziaWebsite c42e74b).
      if (!r.productSlug) {
        warnings.push({ file: "references", path: r.name, message: "n'apparaît que dans “Autres” sur l'accueil : la lier à une réalisation" });
      }
    }
  }

  const cited: [string | null, string, SiteAnyFileName][] = [
    ...projects.flatMap((p): [string | null, string, SiteAnyFileName][] => [
      [p.imagePath, `capture de « ${p.name} »`, "realisations"],
      [p.imageMobilePath, `capture de téléphone de « ${p.name} »`, "realisations"],
      ...(detailOut(p)?.captures ?? []).map((c, i): [string | null, string, SiteAnyFileName] => [c.image, `capture ${i + 1} de la page « ${p.name} »`, "realisations"]),
      ...(detailOut(p)?.avantApres ?? []).flatMap((x): [string | null, string, SiteAnyFileName][] => [
        [x.avant.image, `capture d'avant (${VIEW_LABEL[x.vue]}) de la page « ${p.name} »`, "realisations"],
        [x.apres.image, `capture d'après (${VIEW_LABEL[x.vue]}) de la page « ${p.name} »`, "realisations"],
      ]),
    ]),
    ...references.map((r): [string | null, string, SiteAnyFileName] => [r.logoPath, `logo de « ${r.name} »`, "references"]),
    ...(optional.seo && seo
      ? SITE_PAGE_IDS.map((id): [string | null, string, SiteAnyFileName] => [
          seo.pages[id]?.image ?? null,
          `image de partage de la page « ${SITE_PAGE_LABEL[id]} »`,
          "seo",
        ])
      : []),
  ];
  const mediaNames: Record<string, string> = {};
  const mediaFile: Record<string, SiteAnyFileName> = {};
  const mediaExt: Record<string, SiteMediaExt> = {};
  for (const [path, name, file] of cited) {
    const m = SITE_MEDIA_PATH_RE.exec(path ?? "");
    const sha = m?.[1];
    if (sha && !mediaNames[sha]) {
      mediaNames[sha] = name;
      mediaFile[sha] = file;
      mediaExt[sha] = m![2] as SiteMediaExt;
    }
  }
  const media = Object.keys(mediaNames).sort();
  const sizes = new Map(
    (await prisma.siteMedia.findMany({ where: { sha12: { in: media } }, select: { sha12: true, width: true, height: true } })).map((m) => [m.sha12, m]),
  );
  const known = new Set(sizes.keys());
  // Avant / après : le build du site échoue si les deux captures d'une paire n'ont pas exactement le même ratio (1x).
  for (const p of projects) {
    for (const x of detailOut(p)?.avantApres ?? []) {
      const a = sizes.get(SITE_MEDIA_PATH_RE.exec(x.avant.image)?.[1] ?? "");
      const b = sizes.get(SITE_MEDIA_PATH_RE.exec(x.apres.image)?.[1] ?? "");
      if (a && b && a.width * b.height !== b.width * a.height) {
        issues.push({
          file: "realisations",
          path: `${p.name}, avant / après (${VIEW_LABEL[x.vue]})`,
          message: `Ratios différents : ${a.width}×${a.height} avant, ${b.width}×${b.height} après ; recadrer l'une des deux captures`,
        });
      }
    }
  }
  for (const sha of media) {
    // Fichier en ligne mais absent de l'ERP : contenu repris du site sans ses images, ou base restaurée sans le
    // dossier des fichiers (uploads). Renvoyer l'image depuis la fiche la recrée.
    if (!known.has(sha)) {
      issues.push({ file: mediaFile[sha]!, path: mediaNames[sha]!, message: `Image absente de l'ERP (${sha}) : la renvoyer avec « Remplacer » sur la fiche` });
    }
  }

  const files: SiteSnapshot["files"] = Object.fromEntries(SITE_FILES.map((n) => [n, serializeSiteFile(values[n])])) as Record<SiteFileName, string>;
  for (const n of SITE_OPTIONAL_FILES) if (optional[n] !== undefined) files[n] = serializeSiteFile(optional[n]);
  const names = [...SITE_FILES, ...SITE_OPTIONAL_FILES.filter((n) => files[n] !== undefined)];
  const digest = createHash("sha256")
    .update(names.map((n) => `${n}\n${files[n]}`).join("\n") + media.join(","))
    .digest("hex");
  return { files, media, mediaNames, mediaExt, digest, issues, warnings };
}
