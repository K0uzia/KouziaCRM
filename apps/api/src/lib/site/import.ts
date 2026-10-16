import { SiteItemStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import type { z } from "zod";
import { SITE_FILES, siteFileSchemas, validateSiteFiles, type realisationValue, type referenceValue, type SiteFileName } from "@/lib/site/contract.js";
import { FAQ_PAGE_IN, PROJECT_KIND_IN, REFERENCE_TYPE_IN } from "@/lib/site/mapping.js";

/** Champs de l'ERP d'une réalisation telle que publiée (import, restauration d'une version). */
export function projectFieldsFromSite(r: z.output<typeof realisationValue>) {
  return {
    slug: r.id,
    name: r.nom,
    subtitle: r.sousTitre ?? null,
    mention: r.mention ?? null,
    kind: PROJECT_KIND_IN[r.type],
    text: r.texte,
    role: r.role ?? null,
    techJson: r.techno?.length ? JSON.stringify(r.techno) : null,
    url: r.url,
    linkLabel: r.lien,
    imagePath: r.image,
    imageMobilePath: r.imageMobile ?? null,
    imageAlt: r.imageAlt ?? null,
  };
}

/** Champs publics de l'ERP d'une référence telle que publiée (sans autorisation ni contact : jamais dans le dépôt). */
export function referenceFieldsFromSite(r: z.output<typeof referenceValue>) {
  return {
    slug: r.id,
    type: REFERENCE_TYPE_IN[r.type],
    name: r.nom,
    logoPath: r.logo ?? null,
    logoAlt: r.logoAlt ?? null,
    url: r.url ?? null,
    productSlug: (r.type === "UTILISATEUR" ? r.produit : r.realisation) ?? null,
    // Sans emplacements (fichier antérieur au mur de logos) : bandeau de l'accueil, comme le défaut.
    onHome: r.emplacements ? r.emplacements.includes("accueil") : true,
    onProjects: r.emplacements?.includes("realisations") ?? false,
    testimonialText: r.temoignage?.texte ?? null,
    testimonialAuthor: r.temoignage?.auteur ?? null,
    testimonialRole: r.temoignage?.fonction ?? null,
  };
}

export class SiteImportError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_EMPTY" | "INVALID",
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

/** Contenu déjà saisi dans l'espace Site : l'import (reprise initiale) est alors refusé. */
export async function siteContentExists(): Promise<boolean> {
  const counts = await Promise.all([
    prisma.siteProject.count(),
    prisma.siteReview.count(),
    prisma.siteReference.count(),
    prisma.siteFaq.count(),
    prisma.siteText.count(),
  ]);
  return counts.some((n) => n > 0);
}

/**
 * Reprise du contenu publié du site (les 6 JSON du dépôt) : tout est importé « publié », dans l'ordre des
 * fichiers. Les accords des avis et des références ne sont pas dans le dépôt : à ressaisir (la publication
 * les exige). Une seule fois, sur un espace Site vide.
 */
export async function importSiteFiles(raw: Record<SiteFileName, string>, now = new Date()): Promise<void> {
  if (await siteContentExists()) {
    throw new SiteImportError("L'espace Site contient déjà du contenu : import refusé.", "NOT_EMPTY");
  }
  const json = {} as Record<SiteFileName, unknown>;
  for (const name of SITE_FILES) {
    try {
      json[name] = JSON.parse(raw[name]);
    } catch {
      throw new SiteImportError(`${name}.json illisible`, "INVALID");
    }
  }
  const issues = validateSiteFiles(json);
  if (issues.length) {
    throw new SiteImportError(
      "Contenu du site non conforme",
      "INVALID",
      issues.map((i) => `${i.file}.json, ${i.path} : ${i.message}`),
    );
  }
  const infos = siteFileSchemas.infos.parse(json.infos);
  const textes = siteFileSchemas.textes.parse(json.textes);
  const faq = siteFileSchemas.faq.parse(json.faq);
  const realisations = siteFileSchemas.realisations.parse(json.realisations);
  const avis = siteFileSchemas.avis.parse(json.avis);
  const references = siteFileSchemas.references.parse(json.references);
  const done = { status: SiteItemStatus.PUBLISHED, publishedAt: now };

  await prisma.$transaction([
    ...(avis.methode ? [prisma.siteText.create({ data: { key: "avisMethode", valueJson: JSON.stringify(avis.methode) } })] : []),
    prisma.siteText.create({ data: { key: "infos", valueJson: JSON.stringify(infos.infos) } }),
    prisma.siteText.create({ data: { key: "accroche", valueJson: JSON.stringify(textes.accroche) } }),
    prisma.siteText.create({ data: { key: "offres", valueJson: JSON.stringify(textes.offres) } }),
    ...realisations.realisations.map((r, position) =>
      prisma.siteProject.create({
        data: { ...done, position, ...projectFieldsFromSite(r) },
      }),
    ),
    ...faq.questions.map((q, position) =>
      prisma.siteFaq.create({
        data: { ...done, position, page: FAQ_PAGE_IN[q.page], question: q.q, answer: q.r },
      }),
    ),
    ...avis.avis.map((a, position) =>
      prisma.siteReview.create({
        data: { ...done, position, author: a.auteur, reviewedOn: a.publieLe, experienceOn: a.experienceLe ?? null, text: a.texte },
      }),
    ),
    ...references.references.map((r, position) =>
      prisma.siteReference.create({
        data: { ...done, position, ...referenceFieldsFromSite(r) },
      }),
    ),
  ]);
}
