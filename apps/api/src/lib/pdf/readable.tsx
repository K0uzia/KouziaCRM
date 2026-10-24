import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { Text } from "@react-pdf/renderer";

/**
 * Version lisible d'un PDF (RGAA 13.3, contrat B avec le site) : le gabarit PDF porte des marques <Readable>
 * qui ne rendent rien de plus ; on parcourt son arbre React pour en tirer un JSON structuré. Une seule source :
 * chaque texte du JSON est un texte du PDF, dans le même ordre.
 */

export type ReadableKind = "QUOTE" | "INVOICE" | "DEPOSIT_INVOICE" | "BALANCE_INVOICE" | "CREDIT_NOTE" | "PAYMENT_RECEIPT";

export type ReadableSection = { heading: string | null; paragraphs: string[]; items: string[] };

export type ReadableDocument = {
  version: 1;
  kind: ReadableKind;
  title: string;
  number: string;
  issuer: { name: string; lines: string[] };
  recipient: { heading: string; lines: string[] } | null;
  details: Array<{ label: string; value: string }>;
  table: {
    caption: string;
    columns: Array<{ label: string; align: "start" | "end" }>;
    rows: Array<{ cells: string[]; notes: string[] }>;
  } | null;
  totals: Array<{ label: string; value: string; main: boolean }>;
  sections: ReadableSection[];
  footer: string[];
  source: "ARCHIVE" | "LIVE";
};

/** Texte du PDF dans l'ordre de l'arbre ; group : élément « fixed » répété sur chaque page (en-tête, pied). */
export type ReadableAtom = { text: string; fixedGroup: number | null };

type MarkAs =
  | "issuer" // en-tête de l'émetteur : 1er texte = nom
  | "heading" // intitulé et numéro, déjà dans title et number
  | "detail" // paire libellé, valeur
  | "recipient" // 1er texte = intitulé
  | "section" // heading : 1er texte = titre de section
  | "subheading" // intitulé en capitales dans une section, ramené en casse normale
  | "table" // tableau des lignes
  | "headRow" // en-têtes de colonnes
  | "row" // ligne : une cellule par enfant direct, textes suivants en notes
  | "totals" // paires de totaux, textes libres en section sans titre
  | "pair"
  | "mainPair"
  | "item" // élément de liste : textes joints
  | "footer";

type MarkProps = { as: MarkAs; heading?: boolean; main?: boolean; children?: ReactNode };

/** Marque transparente : rend ses enfants tels quels, le PDF ne change pas. */
export function Readable({ children }: MarkProps) {
  return <>{children}</>;
}

/** Intitulé en capitales du PDF (« FACTURÉ À ») en casse normale : un lecteur d'écran peut épeler les capitales. */
function sentenceCase(s: string): string {
  if (s !== s.toUpperCase() || !/\p{Lu}{2}/u.test(s)) return s;
  const lower = s.toLocaleLowerCase("fr");
  return lower.charAt(0).toLocaleUpperCase("fr") + lower.slice(1);
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function childrenOf(node: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  const push = (n: ReactNode) => {
    if (n === null || n === undefined || typeof n === "boolean") return;
    if (Array.isArray(n)) n.forEach(push);
    else if (isValidElement(n) && n.type === Fragment) push((n.props as { children?: ReactNode }).children);
    else out.push(n);
  };
  push(node);
  return out;
}

type Props = { children?: ReactNode; fixed?: boolean; render?: unknown };

/** Composant du gabarit (fonction sans état) : développé pour lire ce qu'il rend. */
function expand(el: ReactElement): ReactNode {
  const type = el.type as (p: unknown) => ReactNode;
  return type(el.props);
}

const isComponent = (el: ReactElement) => typeof el.type === "function" && el.type !== Readable;

function textOf(node: ReactNode): string {
  return childrenOf(node)
    .map((n) => {
      if (typeof n === "string" || typeof n === "number") return String(n);
      if (isValidElement(n)) {
        if (isComponent(n)) return textOf(expand(n));
        return textOf((n.props as Props).children);
      }
      return "";
    })
    .join("");
}

class Walker {
  atoms: ReadableAtom[] = [];
  private nextGroup = 0;

  newGroup(): number {
    return this.nextGroup++;
  }

  /** Textes d'un sous-arbre, marques ignorées. Chaque Text du PDF devient un atome. */
  collect(node: ReactNode, fixedGroup: number | null = null): string[] {
    const out: string[] = [];
    for (const n of childrenOf(node)) {
      if (!isValidElement(n)) continue;
      const props = n.props as Props;
      if (isComponent(n)) {
        out.push(...this.collect(expand(n), fixedGroup));
        continue;
      }
      const group = fixedGroup ?? (props.fixed ? this.nextGroup++ : null);
      if (n.type === Text) {
        // Numéro de page (render) : propre au PDF, sans équivalent lisible.
        if (props.render) continue;
        const text = textOf(props.children);
        if (!clean(text)) continue;
        this.atoms.push({ text, fixedGroup: group });
        out.push(clean(text));
        continue;
      }
      out.push(...this.collect(props.children, group));
    }
    return out;
  }
}

/** Parcourt un document marqué et remplit le JSON lisible. */
export function readableFromElement(
  element: ReactElement,
  meta: { kind: ReadableKind; number: string; caption: string; source: "ARCHIVE" | "LIVE" },
): { doc: ReadableDocument; atoms: ReadableAtom[] } {
  const w = new Walker();
  const doc: ReadableDocument = {
    version: 1,
    kind: meta.kind,
    title: String((element.props as { title?: string }).title ?? ""),
    number: meta.number,
    issuer: { name: "", lines: [] },
    recipient: null,
    details: [],
    table: null,
    totals: [],
    sections: [],
    footer: [],
    source: meta.source,
  };

  const loose = (texts: string[]) => {
    if (!texts.length) return;
    const last = doc.sections[doc.sections.length - 1];
    if (last && last.heading === null && last.items.length === 0 && lastWasLoose) last.paragraphs.push(...texts);
    else doc.sections.push({ heading: null, paragraphs: texts, items: [] });
    lastWasLoose = true;
  };
  let lastWasLoose = false;

  const rowCells = (row: ReactNode) => {
    // La ligne est un View dont chaque enfant direct est une colonne ; en-tête « fixed » : un seul groupe.
    const view = childrenOf(row).find(isValidElement) as ReactElement | undefined;
    if (!view) return [];
    const group = (view.props as Props).fixed ? w.newGroup() : null;
    return childrenOf((view.props as Props).children).map((c) => w.collect(c, group));
  };

  const section = (node: ReactNode, heading: boolean) => {
    const s: ReadableSection = { heading: null, paragraphs: [], items: [] };
    let columns: string[] = [];
    const visit = (n: ReactNode) => {
      for (const c of childrenOf(n)) {
        if (!isValidElement(c)) continue;
        if (c.type === Readable) {
          const p = c.props as MarkProps;
          if (p.as === "pair" || p.as === "mainPair") {
            const [label = "", ...rest] = w.collect(p.children);
            s.paragraphs.push(rest.length ? `${label} : ${rest.join(" ")}` : label);
          } else if (p.as === "subheading") {
            s.paragraphs.push(...w.collect(p.children).map(sentenceCase));
          } else if (p.as === "headRow") {
            columns = rowCells(p.children).map((cell) => sentenceCase(cell.join(" ")));
          } else if (p.as === "row") {
            const cells = rowCells(p.children).map((cell) => cell.join(" "));
            s.items.push(columns.length ? cells.map((v, i) => `${columns[i] ?? ""} : ${v}`).join(", ") : cells.join(", "));
          } else if (p.as === "item") {
            s.items.push(w.collect(p.children).join(", "));
          } else {
            visit(p.children);
          }
          continue;
        }
        if (isComponent(c)) {
          visit(expand(c));
          continue;
        }
        if (c.type === Text) {
          s.paragraphs.push(...w.collect(c));
          continue;
        }
        visit((c.props as Props).children);
      }
    };
    visit(node);
    if (heading && s.paragraphs.length) s.heading = sentenceCase(s.paragraphs.shift()!);
    if (s.heading || s.paragraphs.length || s.items.length) doc.sections.push(s);
    lastWasLoose = false;
  };

  const table = (node: ReactNode) => {
    const t: NonNullable<ReadableDocument["table"]> = { caption: meta.caption, columns: [], rows: [] };
    for (const c of childrenOf(node)) {
      if (!isValidElement(c)) continue;
      if (c.type === Readable && (c.props as MarkProps).as === "headRow") {
        const head = rowCells((c.props as MarkProps).children).map((cell) => sentenceCase(cell.join(" ")));
        t.columns = head.map((label, i) => ({ label, align: i === 0 ? "start" : "end" }));
      } else if (c.type === Readable && (c.props as MarkProps).as === "row") {
        const cells = rowCells((c.props as MarkProps).children);
        t.rows.push({ cells: cells.map((cell) => cell[0] ?? ""), notes: cells.flatMap((cell) => cell.slice(1)) });
      } else if (c.type === Text) {
        // Titre de pack : ligne de regroupement.
        const [title] = w.collect(c);
        if (title) t.rows.push({ cells: [title, ...t.columns.slice(1).map(() => "")], notes: [] });
      } else {
        table((c.props as Props).children);
        continue;
      }
    }
    if (!doc.table) doc.table = t;
    else {
      doc.table.columns = doc.table.columns.length ? doc.table.columns : t.columns;
      doc.table.rows.push(...t.rows);
    }
  };

  const totals = (node: ReactNode) => {
    for (const c of childrenOf(node)) {
      if (!isValidElement(c)) continue;
      const p = c.props as MarkProps & Props;
      if (c.type === Readable && (p.as === "pair" || p.as === "mainPair")) {
        const [label = "", ...rest] = w.collect(p.children);
        if (rest.length) {
          doc.totals.push({ label, value: rest.join(" "), main: p.as === "mainPair" });
          lastWasLoose = false;
        } else loose([label]);
      } else if (c.type === Readable && p.as === "subheading") {
        loose(w.collect(p.children).map(sentenceCase));
      } else if (c.type === Text) {
        loose(w.collect(c));
      } else if (isComponent(c)) {
        totals(expand(c));
      } else {
        totals(p.children);
      }
    }
  };

  const top = (node: ReactNode) => {
    for (const c of childrenOf(node)) {
      if (!isValidElement(c)) continue;
      const p = c.props as MarkProps & Props;
      if (c.type !== Readable) {
        if (isComponent(c)) top(expand(c));
        else if (c.type === Text) loose(w.collect(c));
        else top(p.children);
        continue;
      }
      switch (p.as) {
        case "issuer": {
          const [name = "", ...lines] = w.collect(p.children);
          doc.issuer = { name, lines };
          break;
        }
        case "heading":
          w.collect(p.children);
          break;
        case "detail": {
          const [label = "", ...rest] = w.collect(p.children);
          doc.details.push({ label, value: rest.join(" ") });
          break;
        }
        case "recipient": {
          const [heading = "", ...lines] = w.collect(p.children);
          doc.recipient = { heading: sentenceCase(heading), lines };
          break;
        }
        case "section":
          section(p.children, p.heading === true);
          break;
        case "table":
          table(p.children);
          break;
        case "totals":
          totals(p.children);
          break;
        case "footer":
          doc.footer.push(...w.collect(p.children));
          break;
        default:
          top(p.children);
      }
    }
  };

  top((element.props as Props).children);
  return { doc, atoms: w.atoms };
}

// \s couvre les espaces insécables ; casse ignorée : textTransform (uppercase) ne change que l'affichage.
const norm = (s: string) => s.replace(/\s/g, "").toLocaleLowerCase("fr");

/**
 * Le texte extrait du PDF (pdf.js) est-il exactement celui des atomes, dans le même ordre ? Espaces ignorés
 * (pdf.js en ajoute ou en retire) et casse ignorés, numéros de page et éléments répétés sur chaque page retirés.
 */
export function sameTextAsPdf(pdfText: string, atoms: ReadableAtom[]): boolean {
  const groups = new Map<number, string>();
  for (const a of atoms) if (a.fixedGroup !== null) groups.set(a.fixedGroup, (groups.get(a.fixedGroup) ?? "") + norm(a.text));
  let pdf = norm(pdfText).replace(/page\d+\/\d+/g, "");
  for (const g of new Set(groups.values())) if (g) pdf = pdf.split(g).join("");
  const body = atoms
    .filter((a) => a.fixedGroup === null)
    .map((a) => norm(a.text))
    .join("");
  return pdf === body;
}

/** Texte d'un PDF tel qu'un lecteur le lit (pdf.js, build Node). */
export async function pdfReadingText(pdf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const parts: string[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const content = await (await doc.getPage(p)).getTextContent();
      for (const it of content.items as Array<{ str?: string }>) if (it.str) parts.push(it.str);
    }
  } finally {
    await task.destroy();
  }
  return parts.join(" ");
}
