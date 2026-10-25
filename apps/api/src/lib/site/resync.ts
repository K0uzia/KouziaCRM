import { createHash } from "node:crypto";
import { z } from "zod";
import { SITE_SCHEMA_VERSION } from "@/lib/site/contract.js";
import { contractFileIssues, fileSchema, type SiteContract } from "@/lib/site/editeur-rules.js";
import { documentDefaults, EDITOR_DOC_IDS, EDITOR_DOCS, readEditorDoc, writeEditorDoc, type EditorDocId } from "@/lib/site/editor.js";

/**
 * « Resynchroniser depuis le site » (demande d'Alexandre du 25/10/2026) : le site affiche ses valeurs par défaut
 * (defauts-erp.json, exportées dans le contrat) partout où le contenu publié n'a pas de clé ; l'ERP ne les avait jamais
 * reprises, d'où des champs vides. La resynchronisation remplit les champs vides de l'ERP avec ce que le site affiche
 * (même fusion que le site : défaut, remplacé clé par clé par le publié ; une liste remplace la liste entière), sans
 * toucher un texte saisi, et retire les champs que le site ne connaît plus (schéma strict : ils bloqueraient la
 * publication). Le plan est montré avant d'être appliqué.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Fusion du site (src/data/contenu.ts, fusion) : clé publiée prioritaire, objets fusionnés, listes remplacées. */
export function siteFusion(defaut: unknown, publie: unknown): unknown {
  if (publie === undefined || publie === null) return defaut;
  if (!isObj(publie) || !isObj(defaut)) return publie;
  const r: Obj = { ...defaut };
  for (const [k, v] of Object.entries(publie)) r[k] = siteFusion(defaut[k], v);
  return r;
}

/** Valeurs par défaut du site pour ce document : celles de l'éditeur, plus les noms des pages des menus. */
function resyncDefaults(id: EditorDocId, contract: SiteContract): unknown {
  const base = documentDefaults(id, contract);
  if (id !== "menus") return base;
  const cibles = ((contract.defauts ?? {}) as Obj).cibles as Record<string, { libelle?: string }> | undefined;
  const libelles = Object.fromEntries(Object.entries(cibles ?? {}).flatMap(([k, c]) => (c?.libelle ? [[k, c.libelle]] : [])));
  return { ...(base ?? {}), libelles };
}

export type ResyncChange = { path: string; value: unknown };
export type ResyncDocPlan = {
  id: EditorDocId;
  label: string;
  /** Champs vides de l'ERP remplis avec le texte affiché par le site. */
  filled: ResyncChange[];
  /** Champs enregistrés dans l'ERP que le site ne connaît plus : retirés. */
  removed: string[];
  /** Textes du site non repris : non conformes au contrat (ex. image par défaut hors /media/). */
  skipped: Array<{ path: string; message: string }>;
  /** Document déjà non conforme dans l'ERP (hors resynchronisation) : rien n'est appliqué tant qu'il n'est pas corrigé. */
  blocked: Array<{ path: string; message: string }>;
};
export type ResyncPlan = { docs: ResyncDocPlan[]; planId: string };

/** Remplit les feuilles vides de `erp` avec celles de `site` ; les listes sont des feuilles. */
function fill(erp: unknown, site: unknown, path: string, out: ResyncChange[]): unknown {
  if (isObj(site)) {
    const base: Obj = isObj(erp) ? { ...erp } : {};
    for (const [k, v] of Object.entries(site)) {
      const next = fill(base[k], v, path ? `${path}.${k}` : k, out);
      if (next !== undefined) base[k] = next;
    }
    return base;
  }
  if (isEmpty(erp) && !isEmpty(site) && !(Array.isArray(site) && site.length === 0)) {
    out.push({ path, value: site });
    return site;
  }
  return erp;
}

const getAt = (o: unknown, path: string[]) => path.reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), o);
function deleteAt(o: Obj, path: string[]) {
  const parent = getAt(o, path.slice(0, -1));
  if (isObj(parent)) delete parent[path[path.length - 1]!];
}

/** Retire les clés que le schéma du fichier refuse (additionalProperties: false), à toute profondeur. */
function prune(contract: SiteContract, file: string, doc: Obj, removed: string[]) {
  const schema = fileSchema(contract, file);
  if (!schema) return;
  const parser = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  for (let round = 0; round < 20; round++) {
    const r = parser.safeParse({ schemaVersion: SITE_SCHEMA_VERSION, ...doc });
    const extra = r.success ? [] : r.error.issues.filter((i) => i.code === "unrecognized_keys");
    if (!extra.length) return;
    for (const i of extra) {
      for (const key of (i as { keys: string[] }).keys) {
        const path = [...i.path.map(String), key];
        removed.push(path.join("."));
        deleteAt(doc, path);
      }
    }
  }
}

/** Plan d'un document : ce qui serait rempli et retiré, et le document qui en résulte (null s'il ne change pas). */
function planDoc(id: EditorDocId, contract: SiteContract, erp: Obj | null, published: Obj | null) {
  const def = EDITOR_DOCS[id];
  const { schemaVersion: _v, ...publie } = published ?? {};
  const site = siteFusion(resyncDefaults(id, contract), published ? publie : undefined);
  const filled: ResyncChange[] = [];
  const removed: string[] = [];
  const skipped: Array<{ path: string; message: string }> = [];
  const doc = (fill(erp ? structuredClone(erp) : undefined, site, "", filled) ?? {}) as Obj;
  prune(contract, def.file, doc, removed);
  // Valeur du site refusée par le contrat : non reprise, le champ reste vide (l'ERP le signale comme avant).
  for (let round = 0; round < 50; round++) {
    const issues = contractFileIssues(contract, def.file, { schemaVersion: SITE_SCHEMA_VERSION, ...doc });
    const bad = issues.map((i) => ({ i, f: filled.find((c) => i.path === c.path || i.path.startsWith(`${c.path}.`)) })).find((x) => x.f);
    if (!bad) break;
    skipped.push({ path: bad.f!.path, message: bad.i.message });
    filled.splice(filled.indexOf(bad.f!), 1);
    const path = bad.f!.path.split(".");
    if (erp && getAt(erp, path) !== undefined) {
      const parent = getAt(doc, path.slice(0, -1));
      if (isObj(parent)) parent[path[path.length - 1]!] = getAt(erp, path);
    } else deleteAt(doc, path);
  }
  const blocked = filled.length || removed.length ? contractFileIssues(contract, def.file, { schemaVersion: SITE_SCHEMA_VERSION, ...doc }) : [];
  return {
    plan: { id, label: def.label, filled, removed, skipped, blocked } satisfies ResyncDocPlan,
    doc: (filled.length || removed.length) && !blocked.length ? doc : null,
  };
}

export type PublishedDocs = Partial<Record<EditorDocId, Obj | null>>;

/** Plan complet ; planId : empreinte du plan, pour n'appliquer que ce qui a été montré. */
export async function resyncPlan(contract: SiteContract, published: PublishedDocs) {
  const docs: Array<{ plan: ResyncDocPlan; doc: Obj | null }> = [];
  for (const id of EDITOR_DOC_IDS) {
    if (!fileSchema(contract, EDITOR_DOCS[id].file)) continue;
    docs.push(planDoc(id, contract, await readEditorDoc(id), published[id] ?? null));
  }
  const plans = docs.map((d) => d.plan);
  const planId = createHash("sha256").update(JSON.stringify(plans)).digest("hex").slice(0, 16);
  return { plan: { docs: plans, planId } satisfies ResyncPlan, docs };
}

export class ResyncStaleError extends Error {}

/** Applique le plan montré : recalculé ici, refusé s'il a changé depuis (site publié ou texte saisi entre-temps). */
export async function applyResync(contract: SiteContract, published: PublishedDocs, planId: string) {
  const { plan, docs } = await resyncPlan(contract, published);
  if (plan.planId !== planId) throw new ResyncStaleError("Le site ou les textes ont changé depuis l'affichage : relisez la liste.");
  for (const d of docs) if (d.doc) await writeEditorDoc(d.plan.id, d.doc, contract);
  return plan;
}
