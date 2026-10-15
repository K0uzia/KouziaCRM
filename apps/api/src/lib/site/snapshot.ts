import { createHash } from "node:crypto";
import { SiteAuthorizationScope, SiteItemStatus, SiteReferenceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import {
  SITE_FILES,
  SITE_SCHEMA_VERSION,
  serializeSiteFile,
  validateSiteFiles,
  type SiteFileName,
  type SiteIssue,
} from "@/lib/site/contract.js";
import { faqOut, projectOut, referenceOut, reviewOut } from "@/lib/site/mapping.js";
import { readSiteText } from "@/lib/site/texts.js";

export type SiteSnapshot = {
  /** Contenu des fichiers src/content/site/<nom>.json, prêt à écrire. */
  files: Record<SiteFileName, string>;
  /** Images de l'ERP citées (sha12) : à publier sous public/media/. */
  media: string[];
  /** Ce que montre chaque image citée (sha12), pour le récapitulatif : « capture de « Nom » », « logo de « Nom » ». */
  mediaNames: Record<string, string>;
  /** Empreinte de l'ensemble : deux instantanés égaux ne donnent aucun commit. */
  digest: string;
  issues: SiteIssue[];
};

const published = { status: SiteItemStatus.PUBLISHED };
const ordered = [{ position: "asc" as const }, { createdAt: "asc" as const }];
const MEDIA_RE = /^\/media\/([a-f0-9]{12})\.webp$/;

/**
 * Instantané du contenu publié (éléments PUBLISHED seulement), validé par les règles de l'ERP et, si
 * fourni, par contenu.schema.json du dépôt. Les accords manquants bloquent la publication.
 */
export async function buildSiteSnapshot(contract?: unknown): Promise<SiteSnapshot> {
  const [projects, reviews, references, faq, infos, accroche, offres, avisMethode] = await Promise.all([
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
  ]);

  const issues: SiteIssue[] = [];
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
    realisations: { schemaVersion: SITE_SCHEMA_VERSION, realisations: projects.map(projectOut) },
    avis: { schemaVersion: SITE_SCHEMA_VERSION, ...(avisMethode ? { methode: avisMethode } : {}), avis: reviews.map(reviewOut) },
    references: { schemaVersion: SITE_SCHEMA_VERSION, references: references.map(referenceOut) },
  };
  if (!infos) issues.push({ file: "infos", path: "infos", message: "Coordonnées non renseignées" });
  if (!accroche || !offres) issues.push({ file: "textes", path: "(racine)", message: "Accroche ou offres non renseignées" });
  issues.push(...validateSiteFiles(values, contract));

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
    }
  }

  const cited: [string | null, string][] = [
    ...projects.flatMap((p): [string | null, string][] => [
      [p.imagePath, `capture de « ${p.name} »`],
      [p.imageMobilePath, `capture de téléphone de « ${p.name} »`],
    ]),
    ...references.map((r): [string | null, string] => [r.logoPath, `logo de « ${r.name} »`]),
  ];
  const mediaNames: Record<string, string> = {};
  for (const [path, name] of cited) {
    const sha = MEDIA_RE.exec(path ?? "")?.[1];
    if (sha && !mediaNames[sha]) mediaNames[sha] = name;
  }
  const media = Object.keys(mediaNames).sort();
  const known = new Set(
    (await prisma.siteMedia.findMany({ where: { sha12: { in: media } }, select: { sha12: true } })).map((m) => m.sha12),
  );
  for (const sha of media) {
    if (!known.has(sha)) issues.push({ file: "realisations", path: sha, message: "Image introuvable dans l'ERP" });
  }

  const files = Object.fromEntries(SITE_FILES.map((n) => [n, serializeSiteFile(values[n])])) as Record<SiteFileName, string>;
  const digest = createHash("sha256")
    .update(SITE_FILES.map((n) => `${n}\n${files[n]}`).join("\n") + media.join(","))
    .digest("hex");
  return { files, media, mediaNames, digest, issues };
}
