import { prisma } from "@/lib/prisma.js";
import { SITE_SCHEMA_VERSION } from "@/lib/site/contract.js";
import { readRepoFileAt, readSiteHeadSha, SITE_CONTENT_DIR } from "@/lib/site/github.js";
import { contractFileIssues, fileSchema, type FieldIssue, type SiteContract } from "@/lib/site/editeur-rules.js";

/**
 * « Tous les textes » (lot générique, validé le 22/10/2026) : documents du site édités depuis le schéma du contrat.
 * Stockage inchangé (table SiteText) : un document entier par ligne pour les fichiers facultatifs (clé = nom du fichier,
 * comme la publication et l'import), en plusieurs lignes pour infos.json et textes.json (clés historiques).
 */
type DocDef = { file: string; label: string } & ({ whole: string } | { parts: Record<string, string> });

export const EDITOR_DOCS = {
  infos: { file: "infos.json", label: "Coordonnées et réseaux", parts: { infos: "infos" } },
  textes: { file: "textes.json", label: "Accroche et offres", parts: { accroche: "accroche", offres: "offres" } },
  pages: { file: "pages.json", label: "Textes des pages", whole: "pages" },
  seo: { file: "seo.json", label: "Référencement", whole: "seo" },
  menus: { file: "menus.json", label: "Menus", whole: "menus" },
  "espace-client": { file: "espace-client.json", label: "Espace client", whole: "espace-client" },
} as const satisfies Record<string, DocDef>;

export type EditorDocId = keyof typeof EDITOR_DOCS;
export const EDITOR_DOC_IDS = Object.keys(EDITOR_DOCS) as EditorDocId[];
export const isEditorDocId = (id: string): id is EditorDocId => Object.hasOwn(EDITOR_DOCS, id);

let cache: { sha: string; value: SiteContract } | null = null;

/**
 * Seule source du contrat (P0 du 26/10/2026) : contenu.schema.json au commit de tête de la branche du site, relu dès
 * que ce commit change. Éditeur, resynchronisation et contrôle avant publication le partagent. Erreur GitHub : propagée.
 */
export async function readSiteContract(force = false): Promise<SiteContract> {
  const sha = await readSiteHeadSha();
  if (!force && cache?.sha === sha) return cache.value;
  const value = JSON.parse(await readRepoFileAt(`${SITE_CONTENT_DIR}/contenu.schema.json`, sha)) as SiteContract;
  cache = { sha, value };
  return value;
}

/** Tests : oublie le contrat en cache. */
export function forgetSiteContract(): void {
  cache = null;
}

/** Texte actuel du site pour ce document (exemple sous un champ vide ; clé absente = texte actuel). */
export function documentDefaults(id: EditorDocId, contract: SiteContract): Record<string, unknown> | null {
  const d = (contract.defauts ?? {}) as Record<string, unknown>;
  switch (id) {
    case "pages":
      return { pages: d.pages ?? {}, communs: d.communs ?? {} };
    case "seo":
      return { pages: d.seo ?? {} };
    case "menus":
      return (d.menus as Record<string, unknown>) ?? null;
    case "espace-client":
      return (d.espaceClient as Record<string, unknown>) ?? null;
    default:
      return null;
  }
}

/** Contenu du document (sans schemaVersion) tel qu'enregistré, null s'il n'a jamais été saisi. */
export async function readEditorDoc(id: EditorDocId): Promise<Record<string, unknown> | null> {
  const def: DocDef = EDITOR_DOCS[id];
  const keys = "whole" in def ? [def.whole] : Object.values(def.parts);
  const rows = new Map((await prisma.siteText.findMany({ where: { key: { in: keys } } })).map((r) => [r.key, JSON.parse(r.valueJson) as unknown]));
  if ("whole" in def) return (rows.get(def.whole) as Record<string, unknown> | undefined) ?? null;
  if (rows.size === 0) return null;
  return Object.fromEntries(Object.entries(def.parts).flatMap(([prop, key]) => (rows.has(key) ? [[prop, rows.get(key)]] : [])));
}

export class EditorValidationError extends Error {
  constructor(readonly issues: FieldIssue[]) {
    super("Contenu non conforme au contrat du site");
  }
}

/**
 * Valide un document avec le contrat du site (JSON Schema et règles « editeur ») puis l'enregistre. Le document est
 * remplacé en entier : l'écran envoie toujours le document complet.
 */
export async function writeEditorDoc(id: EditorDocId, value: Record<string, unknown>, contract: SiteContract): Promise<Record<string, unknown>> {
  const def: DocDef = EDITOR_DOCS[id];
  const issues = contractFileIssues(contract, def.file, { schemaVersion: SITE_SCHEMA_VERSION, ...value });
  if (issues.length) throw new EditorValidationError(issues);
  const rows = "whole" in def ? [[def.whole, value] as const] : Object.entries(def.parts).map(([prop, key]) => [key, value[prop]] as const);
  await prisma.$transaction(
    rows.map(([key, v]) =>
      v === undefined
        ? prisma.siteText.deleteMany({ where: { key } })
        : prisma.siteText.upsert({ where: { key }, create: { key, valueJson: JSON.stringify(v) }, update: { valueJson: JSON.stringify(v) } }),
    ),
  );
  return value;
}

/** Description de l'éditeur pour l'écran : schéma de chaque document déclaré, valeurs, textes actuels du site. */
export async function editorPayload(contract: SiteContract) {
  const docs = [];
  for (const id of EDITOR_DOC_IDS) {
    const def = EDITOR_DOCS[id];
    const schema = fileSchema(contract, def.file);
    if (!schema) continue;
    docs.push({ id, file: def.file, label: def.label, schema, value: await readEditorDoc(id), defaults: documentDefaults(id, contract) });
  }
  const d = (contract.defauts ?? {}) as Record<string, unknown>;
  return {
    editeur: contract.editeur ?? null,
    ciblesLiens: contract.ciblesLiens ?? [],
    variables: contract.variables ?? [],
    // Libellé et chemin de chaque page du site : « où ce texte paraît ».
    cibles: (d.cibles as Record<string, { libelle: string; chemin: string }> | undefined) ?? {},
    // Variables fixées par le site ({ville}) : aperçu des phrases et recherche sur le texte lu.
    valeursVariables: (d.variables as Record<string, string> | undefined) ?? {},
    docs,
  };
}
