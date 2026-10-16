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

/** Sérialisation identique aux fichiers du dépôt : 2 espaces, saut de ligne final (LF). */
export function serializeSiteFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export type SiteIssue = { file: SiteFileName; path: string; message: string };

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
