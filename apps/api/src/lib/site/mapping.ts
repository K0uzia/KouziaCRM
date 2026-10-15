import {
  SiteFaqPage,
  SiteProjectKind,
  SiteReferenceType,
  type SiteFaq,
  type SiteProject,
  type SiteReference,
  type SiteReview,
} from "@prisma/client";
import type { z } from "zod";
import type { avisValue, realisationValue, referenceValue } from "@/lib/site/contract.js";

/** Correspondance entre la base (noms anglais) et le JSON publié (clés et valeurs du contrat du site). */

export const PROJECT_KIND_OUT: Record<SiteProjectKind, "Site web" | "Logiciel"> = {
  WEBSITE: "Site web",
  SOFTWARE: "Logiciel",
};
export const PROJECT_KIND_IN = { "Site web": SiteProjectKind.WEBSITE, Logiciel: SiteProjectKind.SOFTWARE } as const;

export const REFERENCE_TYPE_OUT: Record<SiteReferenceType, "CLIENT" | "PARTENAIRE" | "UTILISATEUR"> = {
  CLIENT: "CLIENT",
  PARTNER: "PARTENAIRE",
  USER: "UTILISATEUR",
};
export const REFERENCE_TYPE_IN = {
  CLIENT: SiteReferenceType.CLIENT,
  PARTENAIRE: SiteReferenceType.PARTNER,
  UTILISATEUR: SiteReferenceType.USER,
} as const;

export const FAQ_PAGE_OUT: Record<SiteFaqPage, "accueil" | "sitesWeb" | "logiciels"> = {
  HOME: "accueil",
  WEBSITES: "sitesWeb",
  SOFTWARE: "logiciels",
};
export const FAQ_PAGE_IN = {
  accueil: SiteFaqPage.HOME,
  sitesWeb: SiteFaqPage.WEBSITES,
  logiciels: SiteFaqPage.SOFTWARE,
} as const;

export function parseTech(techJson: string | null): string[] | undefined {
  if (!techJson) return undefined;
  const list = JSON.parse(techJson) as unknown;
  return Array.isArray(list) && list.length ? list.map(String) : undefined;
}

// Clés dans l'ordre du schéma du site : la sérialisation reste identique au dépôt.
export function projectOut(p: SiteProject): z.input<typeof realisationValue> {
  return {
    id: p.slug,
    nom: p.name,
    sousTitre: p.subtitle ?? undefined,
    // Juste après sousTitre (contrat du site) ; clé absente si vide, jamais "" ni null.
    ...(p.mention ? { mention: p.mention } : {}),
    type: PROJECT_KIND_OUT[p.kind],
    texte: p.text,
    role: p.role ?? undefined,
    techno: parseTech(p.techJson),
    url: p.url,
    lien: p.linkLabel,
    image: p.imagePath,
    // Clé absente (et non undefined) sans capture : un contrat du site antérieur à imageMobile la refuserait.
    ...(p.imageMobilePath ? { imageMobile: p.imageMobilePath } : {}),
  };
}

// Clés facultatives absentes (et non undefined) quand la valeur manque : sérialisation identique au dépôt.
export function reviewOut(r: SiteReview): z.input<typeof avisValue> {
  return { auteur: r.author, publieLe: r.reviewedOn, ...(r.experienceOn ? { experienceLe: r.experienceOn } : {}), texte: r.text };
}

/**
 * Référence : pour un client ou un partenaire (mur de logos), productSlug est la réalisation liée et les
 * emplacements viennent de onHome / onProjects ; pour un utilisateur (ancien « Ils l'utilisent »), c'est le produit.
 */
export function referenceOut(r: SiteReference): z.input<typeof referenceValue> {
  const wall = r.type !== SiteReferenceType.USER;
  const emplacements = [...(r.onHome ? ["accueil" as const] : []), ...(r.onProjects ? ["realisations" as const] : [])];
  return {
    id: r.slug,
    type: REFERENCE_TYPE_OUT[r.type],
    nom: r.name,
    ...(r.logoPath ? { logo: r.logoPath } : {}),
    ...(r.url ? { url: r.url } : {}),
    ...(wall && emplacements.length ? { emplacements } : {}),
    ...(wall && r.productSlug ? { realisation: r.productSlug } : {}),
    ...(!wall && r.productSlug ? { produit: r.productSlug } : {}),
    temoignage:
      r.testimonialText && r.testimonialAuthor
        ? { texte: r.testimonialText, auteur: r.testimonialAuthor, fonction: r.testimonialRole ?? undefined }
        : undefined,
  };
}

export function faqOut(f: SiteFaq) {
  return { page: FAQ_PAGE_OUT[f.page], q: f.question, r: f.answer };
}
