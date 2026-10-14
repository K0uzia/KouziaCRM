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

export function reviewOut(r: SiteReview): z.input<typeof avisValue> {
  return { auteur: r.author, publieLe: r.reviewedOn, texte: r.text };
}

export function referenceOut(r: SiteReference): z.input<typeof referenceValue> {
  return {
    id: r.slug,
    type: REFERENCE_TYPE_OUT[r.type],
    nom: r.name,
    logo: r.logoPath ?? undefined,
    url: r.url ?? undefined,
    produit: r.productSlug ?? undefined,
    temoignage:
      r.testimonialText && r.testimonialAuthor
        ? { texte: r.testimonialText, auteur: r.testimonialAuthor, fonction: r.testimonialRole ?? undefined }
        : undefined,
  };
}

export function faqOut(f: SiteFaq) {
  return { page: FAQ_PAGE_OUT[f.page], q: f.question, r: f.answer };
}
