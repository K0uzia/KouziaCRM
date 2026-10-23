import { SiteItemStatus, SitePublicationStatus, type SitePublication } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { siteFileSchemas, type SiteAnyFileName, type SiteFileName } from "@/lib/site/contract.js";
import { faqOut, FAQ_PAGE_IN, projectOut, referenceOut } from "@/lib/site/mapping.js";
import { projectFieldsFromSite, referenceFieldsFromSite } from "@/lib/site/import.js";
import { writeSiteText, type SiteTextKey } from "@/lib/site/texts.js";

/**
 * Historique des publications : ce que chaque publication a changé sur le site (comparée à la précédente dont les
 * fichiers sont gardés, voir FILES_RETENTION), et restauration d'une version dans l'ERP. Restaurer remet la fiche
 * (ou le texte) dans l'état publié choisi, sans rien mettre en ligne : l'élément passe « Modifié » et part à la
 * publication suivante, comme toute modification. Les témoignages ne se restaurent pas : publiés sans retouche,
 * leurs mots ne changent jamais (charte).
 */

export type HistoryKind = "added" | "removed" | "modified" | "order";
export type HistoryField = { name: string; before: string | null; after: string | null };
export type HistoryEntry = {
  file: SiteAnyFileName;
  key: string;
  label: string;
  kind: HistoryKind;
  fields: HistoryField[];
  /**
   * Versions restaurables : « after » (publiée ici), « before » (celle d'avant cette publication) ; chacune comparée à
   * la fiche actuelle de l'ERP (identique, différente, absente). Vide : rien à restaurer (témoignage, ordre).
   */
  restore: Array<{ side: "after" | "before"; current: "same" | "different" | "absent" }>;
};

type Doc = Record<string, unknown>;
type Item = { key: string; label: string; value: Doc };

/** Libellés des champs publiés (clés du contrat du site). */
const FIELD_LABEL: Record<string, string> = {
  nom: "Nom",
  sousTitre: "Sous-titre",
  mention: "Mention",
  type: "Type",
  texte: "Texte",
  role: "Rôle",
  techno: "Technologies",
  url: "Lien",
  lien: "Libellé du lien",
  image: "Capture",
  imageMobile: "Capture de téléphone",
  imageAlt: "Texte alternatif de la capture",
  miseEnAvant: "Mise en avant sur l'accueil",
  logo: "Logo",
  logoAlt: "Texte alternatif du logo",
  emplacements: "Emplacements",
  realisation: "Réalisation liée",
  produit: "Produit",
  temoignage: "Témoignage",
  page: "Page",
  q: "Question",
  r: "Réponse",
  auteur: "Auteur",
  publieLe: "Publié le",
  experienceLe: "Expérience le",
  titre: "Titre",
  // Documents facultatifs (pages, seo, menus).
  pages: "Pages",
  accueil: "Accueil",
  sitesWeb: "Sites web",
  logiciels: "Logiciels",
  aPropos: "À propos",
  faq: "FAQ",
  hero: "Haut de page",
  services: "Services",
  realisations: "Réalisations",
  maintenanceOption: "Maintenance en option",
  zone: "Zone",
  contact: "Contact",
  surTitre: "Surtitre",
  intro: "Introduction",
  histoire: "Histoire",
  description: "Description",
  entete: "En-tête",
  pied: "Pied de page",
  cible: "Cible",
  libelle: "Libellé",
};

/** Valeurs à plat (chemin → texte) pour comparer deux versions champ par champ. */
function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null)) return { [prefix]: value.join(" ; ") };
    return Object.assign({}, ...value.map((v, i) => flatten(v, `${prefix}.${i + 1}`)));
  }
  if (typeof value === "object") {
    return Object.assign({}, ...Object.entries(value as Doc).map(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k)));
  }
  return { [prefix]: String(value) };
}

const fieldName = (path: string) =>
  path
    .split(".")
    .map((p) => FIELD_LABEL[p] ?? p)
    .join(" › ");

function diffFields(before: unknown, after: unknown, skip: string[] = []): HistoryField[] {
  const a = flatten(before);
  const b = flatten(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !skip.includes(k.split(".")[0]!));
  return keys.filter((k) => a[k] !== b[k]).map((k) => ({ name: fieldName(k), before: a[k] ?? null, after: b[k] ?? null }));
}

/** Documents facultatifs (lot 6) : un seul élément chacun, restauré en entier. */
const OPTIONAL_LABEL: Record<Exclude<SiteAnyFileName, SiteFileName>, string> = {
  pages: "Textes des pages",
  seo: "Référencement des pages",
  menus: "Menus",
  "espace-client": "Textes de l'espace client",
};

/** Éléments d'un fichier publié, avec une clé stable pour comparer deux publications. */
function itemsOf(file: SiteAnyFileName, text: string | undefined): Item[] {
  if (!text) return [];
  const json = JSON.parse(text) as Doc;
  switch (file) {
    case "pages":
    case "seo":
    case "menus":
    case "espace-client": {
      const { schemaVersion: _, ...value } = json;
      return [{ key: file, label: OPTIONAL_LABEL[file], value }];
    }
    case "realisations":
      return (json.realisations as Doc[]).map((r) => ({ key: String(r.id), label: String(r.nom), value: r }));
    case "references":
      return (json.references as Doc[]).map((r) => ({ key: String(r.id), label: String(r.nom), value: r }));
    case "faq":
      return (json.questions as Doc[]).map((q) => ({ key: `${q.page}::${q.q}`, label: String(q.q), value: q }));
    case "avis":
      return [
        ...(json.methode ? [{ key: "avisMethode", label: "Méthode des témoignages", value: json.methode as Doc }] : []),
        ...(json.avis as Doc[]).map((a) => ({ key: `${a.auteur}::${a.publieLe}`, label: `Témoignage de ${a.auteur}`, value: a })),
      ];
    case "textes":
      return [
        { key: "accroche", label: "Accroche de l'accueil", value: json.accroche as Doc },
        { key: "offres", label: "Offres et tarifs", value: json.offres as Doc },
      ];
    case "infos":
      return [{ key: "infos", label: "Coordonnées et réseaux", value: json.infos as Doc }];
  }
}

const ORDERED: SiteAnyFileName[] = ["realisations", "references", "faq", "avis"];
const ORDER_LABEL: Partial<Record<SiteAnyFileName, string>> = {
  realisations: "Ordre des réalisations",
  references: "Ordre des références",
  faq: "Ordre des questions",
  avis: "Ordre des témoignages",
};
const FILE_ORDER: SiteAnyFileName[] = ["realisations", "avis", "references", "faq", "textes", "infos", "pages", "seo", "menus"];

/** Restaurable : réalisations, références, questions et textes ; jamais un témoignage. */
const restorable = (file: SiteAnyFileName, key: string) => file !== "avis" || key === "avisMethode";

/** Forme publiée de la fiche actuelle de l'ERP (tous statuts), pour dire si elle diffère d'une version. */
async function currentValues(): Promise<Map<string, unknown>> {
  const [projects, references, faq, texts] = await Promise.all([
    prisma.siteProject.findMany(),
    prisma.siteReference.findMany(),
    prisma.siteFaq.findMany(),
    prisma.siteText.findMany(),
  ]);
  const map = new Map<string, unknown>();
  for (const p of projects) map.set(`realisations|${p.slug}`, projectOut(p));
  for (const r of references) map.set(`references|${r.slug}`, referenceOut(r));
  for (const f of faq) {
    const out = faqOut(f);
    map.set(`faq|${out.page}::${out.q}`, out);
  }
  for (const t of texts) {
    const file = t.key === "infos" ? "infos" : t.key === "avisMethode" ? "avis" : ["pages", "seo", "menus"].includes(t.key) ? t.key : "textes";
    map.set(`${file}|${t.key}`, JSON.parse(t.valueJson));
  }
  return map;
}

const same = (a: unknown, b: unknown) => JSON.stringify(flatten(a)) === JSON.stringify(flatten(b));

const published = { OR: [{ commitSha: { not: null } }, { status: SitePublicationStatus.NOOP }] };

export class HistoryError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 422,
  ) {
    super(message);
  }
}

/** Publication et celle qui la précède (fichiers gardés, arrivées dans le dépôt). */
async function withPrevious(id: string): Promise<{ pub: SitePublication; prev: SitePublication | null }> {
  const pub = await prisma.sitePublication.findUnique({ where: { id } });
  if (!pub) throw new HistoryError("Publication introuvable", 404);
  const prev = await prisma.sitePublication.findFirst({
    where: { ...published, filesJson: { not: null }, startedAt: { lt: pub.startedAt } },
    orderBy: { startedAt: "desc" },
  });
  return { pub, prev };
}

/**
 * Changements d'une publication. `available` faux : fichiers non gardés (publication antérieure au suivi, ou au-delà
 * de la rétention) ; `first` vrai : aucune publication suivie avant, tout le contenu est présenté comme ajouté.
 */
export async function publicationDetail(id: string): Promise<{ available: boolean; first: boolean; entries: HistoryEntry[] }> {
  const { pub, prev } = await withPrevious(id);
  if (!pub.filesJson) return { available: false, first: false, entries: [] };
  const after = JSON.parse(pub.filesJson) as Record<string, string>;
  const before = prev?.filesJson ? (JSON.parse(prev.filesJson) as Record<string, string>) : {};
  const current = await currentValues();
  const entries: HistoryEntry[] = [];
  for (const file of FILE_ORDER) {
    const a = itemsOf(file, before[file]);
    const b = itemsOf(file, after[file]);
    const byKey = new Map(a.map((x) => [x.key, x]));
    const bKeys = new Set(b.map((x) => x.key));
    const option = (key: string, side: "after" | "before", value: unknown): HistoryEntry["restore"] => {
      if (!restorable(file, key)) return [];
      const cur = current.get(`${file}|${key}`);
      return [{ side, current: cur === undefined ? "absent" : same(cur, value) ? "same" : "different" }];
    };
    for (const item of b) {
      const old = byKey.get(item.key);
      if (!old) {
        entries.push({ file, key: item.key, label: item.label, kind: "added", fields: diffFields(null, item.value, ["id"]), restore: option(item.key, "after", item.value) });
      } else if (!same(old.value, item.value)) {
        entries.push({ file, key: item.key, label: item.label, kind: "modified", fields: diffFields(old.value, item.value), restore: [...option(item.key, "before", old.value), ...option(item.key, "after", item.value)] });
      }
    }
    for (const old of a) {
      if (!bKeys.has(old.key)) {
        entries.push({ file, key: old.key, label: old.label, kind: "removed", fields: diffFields(old.value, null, ["id"]), restore: option(old.key, "before", old.value) });
      }
    }
    // Mêmes éléments dans un autre ordre (le contenu n'a pas changé) : une ligne pour l'ordre.
    const common = b.filter((x) => byKey.has(x.key)).map((x) => x.key);
    const oldOrder = a.filter((x) => bKeys.has(x.key)).map((x) => x.key);
    if (ORDERED.includes(file) && prev && common.join("|") !== oldOrder.join("|")) {
      entries.push({ file, key: "order", label: ORDER_LABEL[file]!, kind: "order", fields: [], restore: [] });
    }
  }
  return { available: true, first: !prev, entries };
}

/** Version d'un élément dans une publication (« after ») ou dans la précédente (« before »). */
async function versionOf(id: string, file: SiteAnyFileName, key: string, side: "after" | "before"): Promise<Item> {
  const { pub, prev } = await withPrevious(id);
  const source = side === "after" ? pub : prev;
  if (!source?.filesJson) throw new HistoryError("Cette version n'est plus conservée.", 404);
  const item = itemsOf(file, (JSON.parse(source.filesJson) as Record<string, string>)[file]).find((x) => x.key === key);
  if (!item) throw new HistoryError("Élément absent de cette version.", 404);
  return item;
}

export type RestoreResult = { file: SiteAnyFileName; key: string; label: string; to: string; created: boolean; missingMedia: string[] };

/**
 * Remet une version publiée dans l'ERP : la fiche existante (même identifiant) reprend les champs publiés, sans
 * changer son statut ni sa place ; une fiche supprimée depuis est recréée en brouillon. Rien n'est mis en ligne.
 */
export async function restoreVersion(id: string, file: SiteAnyFileName, key: string, side: "after" | "before"): Promise<RestoreResult> {
  if (!restorable(file, key)) throw new HistoryError("Un témoignage ne se restaure pas : ses mots restent ceux publiés par l'auteur.", 422);
  const item = await versionOf(id, file, key, side);
  const media = new Set<string>();
  const cite = (path: unknown) => {
    const sha = /^\/media\/([a-f0-9]{12})\.webp$/.exec(typeof path === "string" ? path : "")?.[1];
    if (sha) media.add(sha);
  };
  let to = "/site";
  let created = false;
  if (file === "realisations") {
    const fields = projectFieldsFromSite(siteFileSchemas.realisations.shape.realisations.element.parse(item.value));
    cite(fields.imagePath);
    cite(fields.imageMobilePath);
    const existing = await prisma.siteProject.findUnique({ where: { slug: fields.slug } });
    const row = existing
      ? await prisma.siteProject.update({ where: { id: existing.id }, data: fields })
      : await prisma.siteProject.create({ data: { ...fields, status: SiteItemStatus.DRAFT, position: await nextPosition("project") } });
    created = !existing;
    to = `/site/realisations/${row.id}`;
  } else if (file === "references") {
    const fields = referenceFieldsFromSite(siteFileSchemas.references.shape.references.element.parse(item.value));
    cite(fields.logoPath);
    const existing = await prisma.siteReference.findUnique({ where: { slug: fields.slug } });
    const row = existing
      ? await prisma.siteReference.update({ where: { id: existing.id }, data: fields })
      : await prisma.siteReference.create({ data: { ...fields, status: SiteItemStatus.DRAFT, position: await nextPosition("reference") } });
    created = !existing;
    to = `/site/references/${row.id}`;
  } else if (file === "faq") {
    const q = item.value as { page: keyof typeof FAQ_PAGE_IN; q: string; r: string };
    const existing = await prisma.siteFaq.findFirst({ where: { question: q.q } });
    const data = { page: FAQ_PAGE_IN[q.page], question: q.q, answer: q.r };
    const row = existing
      ? await prisma.siteFaq.update({ where: { id: existing.id }, data })
      : await prisma.siteFaq.create({ data: { ...data, status: SiteItemStatus.DRAFT, position: await nextPosition("faq") } });
    created = !existing;
    to = `/site/faq/${row.id}`;
  } else {
    const textKey = key as SiteTextKey;
    await writeSiteText(textKey, item.value);
    to =
      { infos: "/site/tous-les-textes?page=global", accroche: "/site/tous-les-textes?page=accueil", offres: "/site/tous-les-textes?page=sitesWeb", avisMethode: "/site/avis", pages: "/site/tous-les-textes?page=accueil", seo: "/site/tous-les-textes?page=accueil", menus: "/site/tous-les-textes?page=global", "espace-client": "/site/tous-les-textes?page=espaceClient" }[
        textKey as "infos"
      ] ?? "/site";
  }
  const known = new Set((await prisma.siteMedia.findMany({ where: { sha12: { in: [...media] } }, select: { sha12: true } })).map((m) => m.sha12));
  return { file, key, label: item.label, to, created, missingMedia: [...media].filter((m) => !known.has(m)) };
}

async function nextPosition(kind: "project" | "reference" | "faq"): Promise<number> {
  const agg =
    kind === "project"
      ? await prisma.siteProject.aggregate({ _max: { position: true } })
      : kind === "reference"
        ? await prisma.siteReference.aggregate({ _max: { position: true } })
        : await prisma.siteFaq.aggregate({ _max: { position: true } });
  return (agg._max.position ?? -1) + 1;
}
