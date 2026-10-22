/**
 * « Tous les textes » : champs générés depuis le contrat du site (clé « editeur » du JSON Schema de chaque fichier,
 * KouziaWebsite src/content/schema.ts). Rien n'est codé en dur ici : un champ ajouté par le site paraît tout seul.
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

export type SchemaNode = {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  allOf?: SchemaNode[];
  enum?: unknown[];
  const?: unknown;
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  editeur?: Editeur;
};

export type Path = (string | number)[];
export type Doc = Record<string, unknown>;

/** Un champ racine : un nœud « editeur » qui n'est pas dans un autre (un objet ou une liste rend ses enfants). */
export type Field = { doc: string; path: Path; node: SchemaNode; editeur: Editeur };

/** Champs racines d'un document, dans l'ordre du schéma ; les champs « obsolete » sont écartés. */
export function collectFields(doc: string, schema: SchemaNode): Field[] {
  const out: Field[] = [];
  const visit = (node: SchemaNode, path: Path) => {
    if (node.editeur) {
      if (!node.editeur.obsolete) out.push({ doc, path, node, editeur: node.editeur });
      return;
    }
    for (const [k, child] of Object.entries(node.properties ?? {})) if (k !== "schemaVersion") visit(child, [...path, k]);
  };
  visit(schema, []);
  return out;
}

/** Enfants « editeur » d'un objet (champ objet, élément de liste d'objets), clé par clé. */
export function childFields(node: SchemaNode): { key: string; node: SchemaNode; editeur: Editeur }[] {
  const props = objectNode(node)?.properties ?? {};
  return Object.entries(props).flatMap(([key, child]) => (child.editeur && !child.editeur.obsolete ? [{ key, node: child, editeur: child.editeur }] : []));
}

/** Variante objet d'un nœud (anyOf : la première qui décrit des propriétés). */
export function objectNode(node: SchemaNode): SchemaNode | undefined {
  if (node.properties) return node;
  return node.anyOf?.find((n) => n.properties);
}

/** Contraintes d'un texte, y compris dans un anyOf [texte, ""] ou un allOf de motifs. */
export function textConstraints(node: SchemaNode): { maxLength?: number; minLength?: number; allowEmpty: boolean } {
  const alts = node.anyOf ?? [node];
  const str = alts.find((n) => n.type === "string" && n.const === undefined) ?? node;
  return { maxLength: str.maxLength, minLength: str.minLength, allowEmpty: alts.some((n) => n.const === "") };
}

/** Valeurs permises d'un champ « choix » (enum, ou anyOf de const). */
export function choices(node: SchemaNode): string[] {
  if (node.enum) return node.enum.map(String);
  return (node.anyOf ?? []).flatMap((n) => (n.const !== undefined ? [String(n.const)] : n.enum ? n.enum.map(String) : []));
}

export function getAt(value: unknown, path: Path): unknown {
  let cur = value;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

const isEmpty = (v: unknown) => v === undefined || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/**
 * Valeur posée au chemin, sans modifier l'original. undefined retire la clé, et les objets devenus vides avec elle :
 * clé absente = texte actuel du site.
 */
export function setAt(value: unknown, path: Path, v: unknown): Doc {
  const root = (value && typeof value === "object" ? structuredClone(value) : {}) as Doc;
  if (path.length === 0) return (v ?? {}) as Doc;
  const parents: [Record<string | number, unknown>, string | number][] = [];
  let cur = root as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) {
    if (cur[k] === null || typeof cur[k] !== "object") cur[k] = typeof k === "number" ? [] : {};
    parents.push([cur, k]);
    cur = cur[k] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1]!;
  if (v === undefined) {
    if (Array.isArray(cur)) cur.splice(last as number, 1);
    else delete cur[last];
    // Jusqu'à la clé de premier niveau exclue (pages, connexion…) : le schéma du fichier peut l'exiger.
    for (let i = parents.length - 1; i >= 1; i--) {
      const [p, k] = parents[i]!;
      if (isEmpty(p[k]) && !Array.isArray(p)) delete p[k];
      else break;
    }
  } else cur[last] = v;
  return root;
}

/** Objet minimal d'un schéma : propriétés obligatoires seulement (texte vide, liste vide, objet minimal). */
export function skeleton(node: SchemaNode): unknown {
  const obj = objectNode(node);
  if (obj) {
    return Object.fromEntries((obj.required ?? []).filter((k) => k !== "schemaVersion").map((k) => [k, skeleton(obj.properties![k]!)]));
  }
  if (node.type === "array") return [];
  if (node.type === "boolean") return false;
  if (node.type === "integer" || node.type === "number") return node.minimum ?? 0;
  const c = choices(node);
  return c.length ? c[0] : "";
}

/** Libellé lisible d'une page du site : celui du contrat (cibles), sinon l'identifiant. */
export function pageLabel(id: string, cibles: Record<string, { libelle: string; chemin: string }>): string {
  if (cibles[id]) return cibles[id]!.libelle;
  const known: Record<string, string> = {
    global: "Toutes les pages (en-tête, pied, coordonnées)",
    realisation: "Page projet d'une réalisation",
    merci: "Page « Merci »",
    erreur404: "Page introuvable (404)",
    nouveauClient: "Fiche nouveau client",
  };
  return known[id] ?? id;
}

/** Problème renvoyé par l'API ({ path: "pages.accueil.hero.titre" }) rattaché au champ qui le contient. */
export function issueBelongsTo(issuePath: string, field: Field): boolean {
  const p = field.path.join(".");
  return issuePath === p || issuePath.startsWith(`${p}.`);
}
