import { z } from "zod";

/**
 * Règles de saisie tirées du contrat du site (contenu.schema.json) : le JSON Schema de chaque fichier, et la clé
 * « editeur » de chaque champ (KouziaWebsite, src/content/schema.ts). L'ERP ne code plus en dur la forme de ces
 * documents : un champ ajouté par le site est validé et éditable sans changement ici.
 */
export type Editeur = {
  libelle: string;
  page: string;
  section: string;
  type: string;
  aide?: string;
  variables?: string[];
  liens?: boolean;
  obsolete?: boolean;
};

export type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  editeur?: Editeur;
  [k: string]: unknown;
};

export type SiteContract = {
  schemaVersion?: number;
  fichiers?: Record<string, JsonSchemaNode>;
  fichiersFacultatifs?: Record<string, JsonSchemaNode>;
  editeur?: { version: number; pages: string[]; types: string[] };
  ciblesLiens?: string[];
  variables?: string[];
  defauts?: Record<string, unknown>;
  [k: string]: unknown;
};

export type FieldIssue = { path: string; message: string };

/** Schéma d'un fichier (« pages.json ») déclaré par le contrat, obligatoire ou facultatif. */
export function fileSchema(contract: SiteContract | null | undefined, file: string): JsonSchemaNode | null {
  return contract?.fichiers?.[file] ?? contract?.fichiersFacultatifs?.[file] ?? null;
}

const VARIABLE = /\{([^{}\s]+)\}/g;
const LINK = /\[([^\]]*)\]\(([^)\s]*)\)/g;
const ACCENT = /^[^*]*(\*[^*\s][^*]*\*[^*]*)?$/;

/** Règles d'un texte selon son « editeur » : variables permises, liens [libellé](cible), passage en accent. */
export function textIssues(text: string, ed: Editeur, ciblesLiens: readonly string[]): string[] {
  const out: string[] = [];
  const allowed = ed.variables ?? [];
  for (const [, name] of text.matchAll(VARIABLE)) {
    if (!allowed.includes(name!)) {
      out.push(allowed.length ? `Variable {${name}} non permise ici (permises : ${allowed.map((v) => `{${v}}`).join(", ")})` : `Variable {${name}} non permise ici`);
    }
  }
  for (const [, , target] of text.matchAll(LINK)) {
    if (!ed.liens) out.push("Lien [libellé](cible) non permis dans ce texte");
    else if (!ciblesLiens.includes(target!)) out.push(`Cible de lien inconnue : ${target} (permises : ${ciblesLiens.join(", ")})`);
  }
  if (ed.type === "titreAccent" && !ACCENT.test(text)) out.push("Un seul passage *entre astérisques* au plus");
  return out;
}

/** Parcourt la valeur avec son schéma et applique textIssues à chaque texte d'un champ « editeur ». */
export function editeurIssues(schema: JsonSchemaNode, value: unknown, ciblesLiens: readonly string[], path: (string | number)[] = []): FieldIssue[] {
  const out: FieldIssue[] = [];
  const at = (p: (string | number)[]) => p.join(".") || "(racine)";
  const visit = (node: JsonSchemaNode | undefined, v: unknown, p: (string | number)[], ed: Editeur | undefined) => {
    if (!node || v === undefined || v === null) return;
    const own = node.editeur ?? ed;
    if (typeof v === "string") {
      if (own) for (const m of textIssues(v, own, ciblesLiens)) out.push({ path: at(p), message: m });
      return;
    }
    for (const alt of [...(node.anyOf ?? []), ...(node.allOf ?? [])]) visit(alt, v, p, own);
    if (Array.isArray(v)) {
      // Menus : une même page une seule fois par liste (règle du build du site, hors JSON Schema).
      const targets = v.map((item) => (item && typeof item === "object" ? (item as { cible?: unknown }).cible : undefined)).filter((c) => typeof c === "string");
      if (node.items?.properties?.cible && new Set(targets).size !== targets.length) out.push({ path: at(p), message: "Cible en double" });
      // Liste de textes : la règle du champ liste vaut pour chaque élément ; liste d'objets : chaque champ a la sienne.
      v.forEach((item, i) => visit(node.items, item, [...p, i], typeof item === "string" ? own : undefined));
      return;
    }
    if (typeof v === "object" && node.properties) {
      for (const [k, child] of Object.entries(node.properties)) visit(child, (v as Record<string, unknown>)[k], [...p, k], undefined);
    }
  };
  visit(schema, value, path, undefined);
  return out;
}

/** Validation complète d'un fichier : JSON Schema du site, puis règles « editeur ». value : contenu du fichier. */
export function contractFileIssues(contract: SiteContract, file: string, value: unknown): FieldIssue[] {
  const schema = fileSchema(contract, file);
  if (!schema) return [{ path: "(racine)", message: `${file} n'est pas déclaré par le contrat du site` }];
  const out: FieldIssue[] = [];
  const r = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(value);
  if (!r.success) for (const i of r.error.issues) out.push({ path: i.path.join(".") || "(racine)", message: i.message });
  out.push(...editeurIssues(schema, value, contract.ciblesLiens ?? []));
  return out;
}
