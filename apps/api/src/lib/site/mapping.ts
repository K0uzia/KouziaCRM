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

/** vue : absente = bureau (forme publiée detail.captures[].vue). */
export type ProjectCapture = { image: string; alt: string; caption?: string | null; vue?: "bureau" | "mobile" };
export type ProjectLink = { label: string; url: string };
/** Paire avant / après, stockée sous la forme publiée (detail.avantApres du contrat du site). */
export type ProjectBeforeAfter = {
  vue: "bureau" | "mobile";
  avant: { image: string; alt: string; date: string; source?: string };
  apres: { image: string; alt: string };
};
export const VIEW_LABEL: Record<ProjectBeforeAfter["vue"], string> = { bureau: "ordinateur", mobile: "téléphone" };

export function parseJsonList<T>(json: string | null): T[] {
  if (!json) return [];
  const list = JSON.parse(json) as unknown;
  return Array.isArray(list) ? (list as T[]) : [];
}

const DETAIL_TEXTS = ["contextText", "needText", "approachText", "choicesText", "resultText"] as const;
const filled = (v: string | null | undefined) => Boolean(v?.trim());

/** Projet lié à un client (fiche, nom ou présentation) : rien de nouveau n'en part sans son accord écrit. */
export function concernsClient(p: Pick<SiteProject, "clientId" | "clientName" | "clientIntro">): boolean {
  return Boolean(p.clientId) || filled(p.clientName) || filled(p.clientIntro);
}

/** Saisie de la page projet commencée (un champ au moins). */
export function detailStarted(p: SiteProject): boolean {
  return filled(p.descriptionText) || DETAIL_TEXTS.some((k) => filled(p[k])) || parseJsonList(p.capturesJson).length > 0 || parseJsonList(p.avantApresJson).length > 0;
}

/**
 * Pourquoi la page projet ne part pas (null : elle part). Le site ne la crée qu'avec un texte détaillé ; la description
 * (meta description) est obligatoire ; un projet lié à un client attend son accord écrit (zéro fiction).
 */
export function detailBlocker(p: SiteProject): string | null {
  return detailIssue(p)?.message ?? null;
}

/** Même règle que detailBlocker, avec un code stable (aperçu du brouillon : blockers du contrat du site). */
export function detailIssue(p: SiteProject): { code: string; message: string } | null {
  if (!filled(p.descriptionText)) return { code: "description-manquante", message: "description pour Google manquante" };
  if (!DETAIL_TEXTS.some((k) => filled(p[k]))) return { code: "texte-detaille-manquant", message: "aucun texte détaillé (contexte, besoin, démarche, choix ou résultat)" };
  if (concernsClient(p) && !p.publicationConsentAt) return { code: "accord-client-manquant", message: "accord écrit du client non renseigné" };
  return null;
}

type DetailOut = NonNullable<z.input<typeof realisationValue>["detail"]>;

/** preview : page rendue même si elle ne part pas encore (aperçu du brouillon), champs vides absents. */
export function detailOut(p: SiteProject, opts: { preview?: boolean } = {}): DetailOut | null {
  if (!opts.preview && detailBlocker(p)) return null;
  const consent = Boolean(p.publicationConsentAt);
  const text = (v: string | null) => (filled(v) ? v!.trim() : undefined);
  const captures = parseJsonList<ProjectCapture>(p.capturesJson);
  const links = parseJsonList<ProjectLink>(p.linksJson);
  const pairs = parseJsonList<ProjectBeforeAfter>(p.avantApresJson);
  const entries: [keyof DetailOut, unknown][] = [
    ["description", text(p.descriptionText)],
    ["nature", p.nature === "refonte" || p.nature === "creation" ? p.nature : undefined],
    ["duree", text(p.duree)],
    ["contexte", text(p.contextText)],
    // Nom du client et accord : seulement avec l'accord écrit (contrôlé aussi par le build du site).
    ["clientNom", consent ? text(p.clientName) : undefined],
    ["accordClient", consent ? true : undefined],
    ["client", text(p.clientIntro)],
    ["besoin", text(p.needText)],
    ["demarche", text(p.approachText)],
    ["choix", text(p.choicesText)],
    ["resultat", text(p.resultText)],
    [
      "captures",
      captures.length
        ? captures.map((c) => ({ image: c.image, alt: c.alt, ...(c.caption ? { legende: c.caption } : {}), ...(c.vue === "mobile" ? { vue: "mobile" as const } : {}) }))
        : undefined,
    ],
    [
      "avantApres",
      pairs.length
        ? pairs.map((x) => ({
            vue: x.vue,
            avant: { image: x.avant.image, alt: x.avant.alt, date: x.avant.date, ...(x.avant.source ? { source: x.avant.source } : {}) },
            apres: { image: x.apres.image, alt: x.apres.alt },
          }))
        : undefined,
    ],
    ["liens", links.length ? links.map((l) => ({ libelle: l.label, url: l.url })) : undefined],
  ];
  // Clés absentes (jamais undefined) quand la valeur manque : sérialisation identique au dépôt.
  return Object.fromEntries(entries.filter(([, v]) => v !== undefined)) as DetailOut;
}

// Clés dans l'ordre du schéma du site : la sérialisation reste identique au dépôt.
export function projectOut(p: SiteProject, opts: { preview?: boolean } = {}): z.input<typeof realisationValue> {
  const detail = opts.preview ? (detailStarted(p) ? detailOut(p, { preview: true }) : null) : detailOut(p);
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
    // "" est une valeur (capture décorative) : seule l'absence de saisie (null) laisse le site calculer.
    ...(p.imageAlt !== null ? { imageAlt: p.imageAlt } : {}),
    ...(detail ? { detail } : {}),
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
    ...(r.logoAlt ? { logoAlt: r.logoAlt } : {}),
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
