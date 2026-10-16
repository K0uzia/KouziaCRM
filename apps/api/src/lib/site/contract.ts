import { z } from "zod";

/**
 * Contrat du contenu publié dans le dépôt KouziaWebsite (src/content/site/*.json), clés françaises.
 * Reprend src/content/schema.ts du site. Son export contenu.schema.json ne porte que la structure : les
 * règles de la charte (https, pas de lien vers du code source, pas de tiret cadratin, identifiants uniques)
 * sont donc appliquées ici, avant toute publication. Le build du site reste le dernier contrôle.
 */
export const SITE_SCHEMA_VERSION = 1;

export const SITE_FILES = ["infos", "textes", "faq", "realisations", "avis", "references"] as const;
export type SiteFileName = (typeof SITE_FILES)[number];

const DASHES = /[\u2013\u2014]/;
export const siteText = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !DASHES.test(s), "Tiret cadratin ou demi-cadratin interdit (charte)");

const CODE_HOSTS = /^https:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org)\//;
export const httpsUrl = z.url({ protocol: /^https$/, error: "Lien https obligatoire" });
const projectUrl = httpsUrl.refine((u) => !CODE_HOSTS.test(u), "Lien vers du code source interdit (charte)");

export const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Identifiant : minuscules, chiffres et tirets");
export const imagePath = z.string().regex(/^\/(projets|media)\/[a-z0-9-]+\.webp$/);
const logoPath = z.string().regex(/^\/media\/[a-z0-9-]+\.webp$/);

const file = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ schemaVersion: z.literal(SITE_SCHEMA_VERSION), ...shape });

export const infosValue = z.strictObject({
  email: z.email(),
  telephone: z.string().regex(/^0\d( \d\d){4}$/, "Téléphone au format 06 12 34 56 78"),
  delaiReponse: siteText,
  anneesExperience: z.int().min(0).max(80),
  zone: siteText,
  villes: z.array(siteText).min(1),
  github: httpsUrl,
  instagram: httpsUrl,
  ficheGoogle: httpsUrl,
  avisGoogle: httpsUrl,
});

export const accrocheValue = z.strictObject({ titre: siteText, texte: siteText });
const formule = z.strictObject({ titre: siteText, items: z.array(siteText).min(1) });
export const offresValue = z.strictObject({
  formules: z.strictObject({ site: formule, logiciel: formule }),
  tarif: siteText,
});

export const realisationValue = z.strictObject({
  id: slug,
  nom: siteText,
  sousTitre: siteText.optional(),
  /** Petite ligne sous le titre de la carte de réalisation. */
  mention: siteText.max(60).optional(),
  type: z.enum(["Site web", "Logiciel"]),
  texte: siteText,
  role: siteText.optional(),
  techno: z.array(siteText).optional(),
  url: projectUrl,
  lien: siteText,
  image: imagePath,
  imageMobile: imagePath.optional(),
  /** Texte alternatif de la capture : absent = calculé par le site (altCapture), "" = capture décorative. */
  imageAlt: z.union([z.literal(""), siteText.max(200)]).optional(),
});

export const avisValue = z.strictObject({
  auteur: siteText,
  publieLe: z.iso.date(),
  /** Date de l'expérience de consommation, affichée près de l'avis (D111-17). */
  experienceLe: z.iso.date().optional(),
  texte: siteText,
});

/** « Comment les avis sont recueillis et vérifiés » (L111-7-2 et D111-17/18 du Code de la consommation). */
export const avisMethodeValue = z.strictObject({ titre: siteText.max(120), texte: siteText.max(4000) });

export const referenceValue = z
  .strictObject({
    id: slug,
    type: z.enum(["CLIENT", "PARTENAIRE", "UTILISATEUR"]),
    nom: siteText,
    logo: logoPath.optional(),
    /** Texte alternatif du logo, nom du lien vers la structure : absent = nom de la structure. */
    logoAlt: siteText.max(120).optional(),
    url: httpsUrl.optional(),
    /** accueil : bandeau « Ils m'ont fait confiance » ; realisations : sous les exemples de réalisations. */
    emplacements: z
      .array(z.enum(["accueil", "realisations"]))
      .min(1)
      .refine((l) => new Set(l).size === l.length, "Emplacement en double")
      .optional(),
    realisation: slug.optional(),
    produit: z.string().optional(),
    temoignage: z.strictObject({ texte: siteText, auteur: siteText, fonction: siteText.optional() }).optional(),
  })
  .refine((r) => r.type !== "UTILISATEUR" || Boolean(r.produit), "Produit obligatoire pour « Ils l'utilisent »");

const uniqueIds = <T extends { id: string }>(list: T[]) => new Set(list.map((r) => r.id)).size === list.length;

export const siteFileSchemas = {
  infos: file({ infos: infosValue }),
  textes: file({ accroche: accrocheValue, offres: offresValue }),
  faq: file({
    questions: z.array(
      z.strictObject({ page: z.enum(["accueil", "sitesWeb", "logiciels"]), q: siteText, r: siteText }),
    ),
  }),
  realisations: file({
    realisations: z.array(realisationValue).refine(uniqueIds, "Identifiants de réalisation en double"),
  }),
  avis: file({ methode: avisMethodeValue.optional(), avis: z.array(avisValue) }).refine((f) => f.avis.length === 0 || Boolean(f.methode), {
    message: "Méthode de recueil et de vérification requise dès qu'un avis est publié",
    path: ["methode"],
  }),
  references: file({
    references: z.array(referenceValue).refine(uniqueIds, "Identifiants de référence en double"),
  }),
} satisfies Record<SiteFileName, z.ZodType>;

export type SiteFiles = { [K in SiteFileName]: z.output<(typeof siteFileSchemas)[K]> };

/**
 * Fichiers facultatifs (lot 6), déclarés par le site sous « fichiersFacultatifs » de contenu.schema.json : absents,
 * le site garde ses textes actuels. L'ERP ne les écrit que si le contrat du dépôt les connaît.
 */
export const SITE_OPTIONAL_FILES = ["pages", "seo", "menus"] as const;
export type SiteOptionalFileName = (typeof SITE_OPTIONAL_FILES)[number];
export type SiteAnyFileName = SiteFileName | SiteOptionalFileName;

/** Pages indexables du site (clés de contenu.ts), seules visées par seo.json et les menus. */
export const SITE_PAGE_IDS = ["accueil", "sitesWeb", "logiciels", "faq", "aPropos"] as const;
export type SitePageId = (typeof SITE_PAGE_IDS)[number];

/** Nom d'une page du site dans l'ERP (récapitulatif de publication). */
export const SITE_PAGE_LABEL: Record<SitePageId, string> = {
  accueil: "Accueil",
  sitesWeb: "Sites web",
  logiciels: "Logiciels",
  faq: "Questions fréquentes",
  aPropos: "À propos",
};
/** Cibles d'un lien de menu : pages, ancres de l'accueil, et l'espace client (pied seulement : l'en-tête a son lien fixe). */
export const MENU_HEADER_TARGETS = [...SITE_PAGE_IDS, "services", "realisations", "methode", "contact"] as const;
export const MENU_TARGETS = [...MENU_HEADER_TARGETS, "espaceClient"] as const;
export type MenuTarget = (typeof MENU_TARGETS)[number];

/** Variables permises dans les textes du site, remplacées par le site au build. */
export const SITE_TEXT_VARIABLES = ["ville", "delaiReponse"] as const;
const KNOWN_VARIABLES_ONLY = /^(?:[^{}]|\{(?:ville|delaiReponse)\})*$/;
const template = (max: number) =>
  siteText.max(max).regex(KNOWN_VARIABLES_ONLY, "Variable inconnue : seules {ville} et {delaiReponse} sont permises");
const plainTemplate = (max: number) => template(max).regex(/^[^*]*$/, "Astérisque interdit ici");
/** Titre avec au plus un passage *entre astérisques*, affiché en couleur d'accent sur le site. */
const accentTemplate = (max: number) => template(max).regex(/^[^*]*(\*[^*\s][^*]*\*[^*]*)?$/, "Un seul passage *entre astérisques* au plus");

const pageBlock = z.strictObject({ surTitre: plainTemplate(40).optional(), titre: plainTemplate(90).optional(), intro: plainTemplate(300).optional() });
const serviceHero = z.strictObject({ surTitre: plainTemplate(60).optional(), titre: plainTemplate(90).optional(), intro: plainTemplate(300).optional() });
/** pages.json sans schemaVersion (lot 6 A) : textes affichés des pages, ordre des clés du contrat du site. */
export const pagesValue = z.strictObject({
  pages: z.strictObject({
    accueil: z
      .strictObject({
        hero: z.strictObject({ surTitre: plainTemplate(60).optional(), titre: accentTemplate(90).optional() }).optional(),
        services: pageBlock.optional(),
        realisations: pageBlock.optional(),
        maintenanceOption: z.strictObject({ titre: plainTemplate(60).optional(), texte: plainTemplate(200).optional() }).optional(),
        zone: z.strictObject({ titre: plainTemplate(60).optional(), texte: plainTemplate(400).optional() }).optional(),
        contact: z.strictObject({ titre: accentTemplate(90).optional(), intro: plainTemplate(300).optional() }).optional(),
      })
      .optional(),
    sitesWeb: z.strictObject({ hero: serviceHero.optional() }).optional(),
    logiciels: z.strictObject({ hero: serviceHero.optional() }).optional(),
    aPropos: z.strictObject({ titre: plainTemplate(90).optional(), histoire: plainTemplate(600).optional() }).optional(),
    faq: z.strictObject({ intro: plainTemplate(300).optional() }).optional(),
  }),
});

export const SEO_TITLE_MAX = 60;
export const SEO_DESCRIPTION_MIN = 140;
export const SEO_DESCRIPTION_MAX = 155;
export const SEO_IMAGE_ALT_MAX = 120;
export const MENU_LABEL_MAX = 30;
export const shareImagePath = z.string().regex(/^\/media\/[a-z0-9]{12}\.jpg$/, "Image de partage attendue : /media/<12 caractères>.jpg");

const seoShare = {
  description: template(SEO_DESCRIPTION_MAX).min(SEO_DESCRIPTION_MIN).optional(),
  image: shareImagePath.optional(),
  imageAlt: plainTemplate(SEO_IMAGE_ALT_MAX).optional(),
};
const seoPage = z.strictObject({ titre: plainTemplate(SEO_TITLE_MAX).optional(), ...seoShare });
/** seo.json sans schemaVersion. Charte : le titre de l'accueil est fixe, la clé titre y est refusée. */
export const seoValue = z.strictObject({
  pages: z.strictObject({
    accueil: z.strictObject(seoShare).optional(),
    sitesWeb: seoPage.optional(),
    logiciels: seoPage.optional(),
    faq: seoPage.optional(),
    aPropos: seoPage.optional(),
  }),
});

const menuEntry = <T extends readonly [string, ...string[]]>(targets: T) =>
  z.strictObject({ cible: z.enum(targets), libelle: plainTemplate(MENU_LABEL_MAX).optional() });
const noDuplicateTarget = (l: { cible: string }[]) => new Set(l.map((e) => e.cible)).size === l.length;
/** menus.json sans schemaVersion : liens d'en-tête (1 à 6) et de pied de page (1 à 10). */
export const menusValue = z.strictObject({
  entete: z.array(menuEntry(MENU_HEADER_TARGETS)).min(1).max(6).refine(noDuplicateTarget, "Cible en double").optional(),
  pied: z.array(menuEntry(MENU_TARGETS)).min(1).max(10).refine(noDuplicateTarget, "Cible en double").optional(),
});

export const siteOptionalSchemas = {
  pages: file({ pages: pagesValue.shape.pages }),
  seo: file({ pages: seoValue.shape.pages }),
  menus: file(menusValue.shape),
} satisfies Record<SiteOptionalFileName, z.ZodType>;

/** Fichiers facultatifs que le contrat du dépôt déclare : seuls ceux-là sont publiables. */
export function contractOptionalFiles(contract: unknown): Set<SiteOptionalFileName> {
  const declared = (contract as { fichiersFacultatifs?: Record<string, unknown> } | null)?.fichiersFacultatifs ?? {};
  return new Set(SITE_OPTIONAL_FILES.filter((n) => Object.hasOwn(declared, `${n}.json`)));
}

/** Valide les fichiers facultatifs produits : règles de l'ERP, puis le schéma déclaré par le site, s'il est fourni. */
export function validateOptionalSiteFiles(files: Partial<Record<SiteOptionalFileName, unknown>>, contract?: unknown): SiteIssue[] {
  const issues: SiteIssue[] = [];
  const declared = (contract as { fichiersFacultatifs?: Record<string, unknown> } | null)?.fichiersFacultatifs ?? {};
  for (const name of SITE_OPTIONAL_FILES) {
    if (files[name] === undefined) continue;
    const local = siteOptionalSchemas[name].safeParse(files[name]);
    if (!local.success) {
      for (const i of local.error.issues) issues.push({ file: name, path: i.path.join(".") || "(racine)", message: i.message });
    }
    const js = declared[`${name}.json`];
    if (js) {
      const r = z.fromJSONSchema(js as Parameters<typeof z.fromJSONSchema>[0]).safeParse(files[name]);
      if (!r.success) {
        for (const i of r.error.issues) issues.push({ file: name, path: i.path.join(".") || "(racine)", message: `Contrat du site : ${i.message}` });
      }
    }
  }
  return issues;
}

/** Sérialisation identique aux fichiers du dépôt : 2 espaces, saut de ligne final (LF). */
export function serializeSiteFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type SiteIssue = { file: SiteAnyFileName; path: string; message: string };

/**
 * Valide les 6 fichiers : règles de l'ERP (charte comprise), puis, si fourni, contenu.schema.json lu dans
 * le dépôt (structure, pour détecter un contrat du site plus récent que l'ERP).
 */
export function validateSiteFiles(files: Record<SiteFileName, unknown>, contract?: unknown): SiteIssue[] {
  const issues: SiteIssue[] = [];
  const remote = remoteSchemas(contract);
  for (const name of SITE_FILES) {
    const local = siteFileSchemas[name].safeParse(files[name]);
    if (!local.success) {
      for (const i of local.error.issues) {
        issues.push({ file: name, path: i.path.join(".") || "(racine)", message: i.message });
      }
    }
    const schema = remote?.[`${name}.json`];
    if (schema) {
      const r = schema.safeParse(files[name]);
      if (!r.success) {
        for (const i of r.error.issues) {
          // Champ récent de l'ERP que la version en ligne du site ne connaît pas encore (contrat en strictObject).
          const message =
            i.code === "unrecognized_keys"
              ? `Contrat du site : ${i.keys.join(", ")} pas encore pris en charge par kouzia.com ; mettre le site à jour avant de publier, ou vider ce champ`
              : `Contrat du site : ${i.message}`;
          issues.push({ file: name, path: i.path.join(".") || "(racine)", message });
        }
      }
    }
  }
  return issues;
}

function remoteSchemas(contract: unknown): Record<string, z.ZodType> | null {
  if (!contract || typeof contract !== "object") return null;
  const c = contract as { schemaVersion?: unknown; fichiers?: Record<string, unknown> };
  if (c.schemaVersion !== SITE_SCHEMA_VERSION) {
    throw new SiteContractError(
      `Le site attend le format ${String(c.schemaVersion)} ; cet ERP publie le format ${SITE_SCHEMA_VERSION}. Mettre l'ERP à jour.`,
    );
  }
  const out: Record<string, z.ZodType> = {};
  for (const [name, js] of Object.entries(c.fichiers ?? {})) {
    out[name] = z.fromJSONSchema(js as Parameters<typeof z.fromJSONSchema>[0]);
  }
  return out;
}

export class SiteContractError extends Error {}
