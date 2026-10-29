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
  /** Pages où le texte paraît vraiment (texte commun à quelques pages) ; absent : « page ». */
  affichage?: string[];
};

/**
 * Phrase affichée assemblée de plusieurs champs (clé « phrases » à la racine du schéma d'un fichier) : texte fixe, champ
 * du même fichier (chemin depuis sa racine), nom d'une page du site ou variable des textes.
 */
export type Morceau =
  | string
  | { champ: string; gras?: boolean; lien?: boolean; sansPointFinal?: boolean }
  | { page: string; lien?: boolean }
  | { variable: string };
export type Phrase = { morceaux: Morceau[] };

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
  phrases?: Phrase[];
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

/** Libellé lisible d'une page du site : celui du contrat (cibles), sinon un nom connu, jamais la clé technique. */
export function pageLabel(id: string, cibles: Record<string, { libelle: string; chemin: string }>): string {
  if (cibles[id]) return cibles[id]!.libelle;
  const known: Record<string, string> = {
    global: "Plusieurs pages (en-tête, pied, coordonnées)",
    realisation: "Page projet d'une réalisation",
    merci: "Page « Merci »",
    erreur404: "Page introuvable (404)",
    nouveauClient: "Fiche nouveau client",
    planDuSite: "Plan du site",
    cgv: "CGV",
  };
  if (known[id]) return known[id]!;
  // Page ajoutée par le site sans nom connu : « nouvellePage » devient « Nouvelle page ».
  const words = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Pages où un champ paraît : « affichage » du contrat (texte commun à quelques pages), sinon sa page. */
export function fieldPages(ed: Editeur): string[] {
  return ed.affichage?.length ? ed.affichage : [ed.page];
}

/** « Accueil, Sites web et Logiciels ». */
export function joinLabels(labels: string[]): string {
  return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} et ${labels[labels.length - 1]}` : (labels[0] ?? "");
}

const READABLE = new Set(["court", "long", "titreAccent"]);
const TITLE_KEYS = ["titre", "nom", "q", "libelle"];

/**
 * Titre d'un élément de liste : son champ titre (titre, nom, question, libellé), sinon son premier texte lisible ; jamais
 * une valeur technique (icône, choix, identifiant, lien, image).
 */
export function itemTitle(itemNode: SchemaNode, item: unknown): string | null {
  const children = childFields(itemNode);
  const text = (key: string) => {
    const v = getAt(item, [key]);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  for (const key of TITLE_KEYS) {
    const c = children.find((x) => x.key === key && READABLE.has(x.editeur.type));
    if (c && text(c.key)) return text(c.key);
  }
  for (const c of children) if (READABLE.has(c.editeur.type) && text(c.key)) return text(c.key);
  return null;
}

/** Recherche : sans casse, sans accents, espaces insécables et suites d'espaces ramenés à une espace. */
export function normalizeSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\s    ]+/g, " ")
    .toLowerCase()
    .trim();
}

/** Textes d'une valeur (texte, liste, objet), dans l'ordre. */
export function textsOf(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(textsOf);
  if (v && typeof v === "object") return Object.values(v).flatMap(textsOf);
  return [];
}

/** Variables {nom} remplacées par leur valeur connue ; une variable sans valeur reste écrite telle quelle. */
export function fillVariables(text: string, values: Record<string, string | undefined>): string {
  return text.replace(/\{([^{}\s]+)\}/g, (all, name: string) => values[name] ?? all);
}

/** Morceau rendu d'un aperçu : texte, mise en forme du site, et s'il vient du champ édité. */
export type Segment = { text: string; gras?: boolean; lien?: boolean; current?: boolean };

export type PhraseContext = {
  /** Valeur affichée d'un champ du même fichier : saisie en cours, sinon texte actuel du site. */
  value: (path: Path) => unknown;
  /** Nom d'une page du site. */
  page: (id: string) => string;
  variables: Record<string, string | undefined>;
};

/** Chemin « pages.accueil.contact.intro » d'un morceau. */
export const morceauPath = (champ: string): Path => champ.split(".");

const samePath = (a: Path, b: Path) => a.length === b.length && a.every((k, i) => String(k) === String(b[i]));

/** Phrases d'un fichier qui citent ce champ. */
export function phrasesOf(schema: SchemaNode, path: Path): Phrase[] {
  return (schema.phrases ?? []).filter((p) => p.morceaux.some((m) => typeof m === "object" && "champ" in m && samePath(morceauPath(m.champ), path)));
}

/** Phrase telle que le site l'assemble, avec la valeur en cours de chaque champ ; current marque le champ édité. */
export function renderPhrase(phrase: Phrase, ctx: PhraseContext, current?: Path): Segment[] {
  return phrase.morceaux.map((m): Segment => {
    if (typeof m === "string") return { text: m };
    if ("champ" in m) {
      const path = morceauPath(m.champ);
      const v = ctx.value(path);
      let text = fillVariables(typeof v === "string" ? v : "", ctx.variables);
      if (m.sansPointFinal) text = text.replace(/\.$/, "");
      return { text, gras: m.gras, lien: m.lien, current: current ? samePath(path, current) : false };
    }
    if ("page" in m) return { text: ctx.page(m.page), lien: m.lien };
    return { text: ctx.variables[m.variable] ?? `{${m.variable}}` };
  });
}

export const phraseText = (segments: Segment[]) => segments.map((s) => s.text).join("");

/**
 * Texte cherché pour un champ, normalisé : libellé, section, texte lu sur le site (saisi ou actuel, variables remplacées)
 * et phrases assemblées qui le contiennent.
 */
export function searchText(f: Field, schema: SchemaNode, ctx: PhraseContext): string {
  const shown = textsOf(ctx.value(f.path)).map((t) => fillVariables(t, ctx.variables));
  const phrases = phrasesOf(schema, f.path).map((ph) => phraseText(renderPhrase(ph, ctx)));
  return normalizeSearch([f.editeur.libelle, f.editeur.section, ...shown, ...phrases].join("\n"));
}

/** Problème renvoyé par l'API ({ path: "pages.accueil.hero.titre" }) rattaché au champ qui le contient. */
export function issueBelongsTo(issuePath: string, field: Field): boolean {
  const p = field.path.join(".");
  return issuePath === p || issuePath.startsWith(`${p}.`);
}
