import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isNetworkFailure, isOnline } from "@/lib/network";
import { offlineEnabled } from "./config";
import { shouldNotifySystem } from "../system-notify";
import { COPY_FORMAT, COPY_SUMMARY_KEY, copiesSize, deleteCopiesWhere, readCopy } from "./store";
import { addJournalEntry, refusalHint, type JournalEntry } from "./journal";

/**
 * Copie automatique complète pour le hors ligne (décision d'Alexandre du 19/10/2026). Sur l'origine du hors ligne
 * seulement, l'ERP lit en arrière-plan toute la liste fermée (lib/offline/rules) : clients et leurs fiches, notes,
 * projets et pièces, devis et factures avec leur détail, prestations. Chaque lecture passe par api(), qui chiffre
 * et range la copie comme une consultation : mêmes données, mêmes exclusions (ni paiements, ni messagerie, ni PDF,
 * ni preuves de signature, ni secrets). Ensuite, mise à jour incrémentale : une fiche n'est relue que si la liste
 * la dit modifiée depuis sa copie (updatedAt). Débit limité : deux lectures à la fois, une courte pause entre deux.
 */

export type CopyPhase = "Clients" | "Devis" | "Factures" | "Prestations" | "Pilotage" | "Comptabilité" | "Abonnements" | "Messagerie" | "Réglages";
export type CopySummary = {
  at: number;
  clients: number;
  quotes: number;
  invoices: number;
  services: number;
  /** Fils de messages des 90 derniers jours copiés (texte seulement). */
  threads?: number;
  sizeBytes: number | null;
  /** Format des copies et liste des lectures : un changement relance une copie complète. */
  format: number;
  full: boolean;
};
export type CopyState = {
  running: boolean;
  /** Fenêtre de progression ouverte (copie complète, ou relancée à la main). */
  visible: boolean;
  mode: "full" | "incremental" | null;
  phase: CopyPhase | null;
  done: number;
  total: number;
  error: string | null;
  summary: CopySummary | null;
};

/** À augmenter quand la liste des lectures copiées change : la copie suivante est complète. */
export const SYNC_FORMAT = COPY_FORMAT * 100 + 2;
const SUMMARY_KEY = COPY_SUMMARY_KEY;
const CONCURRENCY = 2;
const PAUSE_MS = 120;
/** Pause réelle (tests : 0). */
let pauseMs = PAUSE_MS;
/** Rafraîchissement complet silencieux au plus tard tous les jours (notes et projets sans date de modification). */
const FULL_EVERY_MS = 24 * 60 * 60 * 1000;

function readSummary(): CopySummary | null {
  try {
    const raw = localStorage.getItem(SUMMARY_KEY);
    return raw ? (JSON.parse(raw) as CopySummary) : null;
  } catch {
    return null;
  }
}

function writeSummary(summary: CopySummary): void {
  try {
    localStorage.setItem(SUMMARY_KEY, JSON.stringify(summary));
  } catch {
    /* navigation privée : l'état reste en mémoire */
  }
}

let state: CopyState = { running: false, visible: false, mode: null, phase: null, done: 0, total: 0, error: null, summary: readSummary() };
const listeners = new Set<() => void>();
let controller: AbortController | null = null;

function set(patch: Partial<CopyState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function copyState(): CopyState {
  return state;
}

export function useOfflineCopy(): CopyState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** Fenêtre de progression refermée : la copie continue en arrière-plan. */
export function hideCopyPanel(): void {
  set({ visible: false });
}

export function cancelOfflineCopy(): void {
  controller?.abort();
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Copie annulée", "AbortError"));
    }, { once: true });
  });

/** Lectures en parallèle limité, avec pause : une connexion 4G reste utilisable pendant la copie. */
async function pool<T>(items: T[], signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      if (signal.aborted) throw new DOMException("Copie annulée", "AbortError");
      const item = items[next++]!;
      await work(item);
      await sleep(pauseMs, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner));
}

type Listed = { id: string; updatedAt?: string | null; clientId?: string | null; notepadUpdatedAt?: string | null };

/** Copie de ce chemin à jour par rapport à la date de modification donnée par la liste ? */
async function upToDate(path: string, updatedAt: string | null | undefined): Promise<boolean> {
  const copy = await readCopy(path).catch(() => null);
  if (!copy) return false;
  const changed = updatedAt ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(changed) ? copy.savedAt >= changed : true;
}

/** Bilan de la copie en cours, pour le journal de diagnostic : lectures copiées, refus par statut HTTP. */
let tally: { copied: number; refused: Record<string, number> } = { copied: 0, refused: {} };

async function read(path: string, signal: AbortSignal): Promise<unknown> {
  try {
    const data = await api<unknown>(path, { signal });
    tally.copied++;
    return data;
  } catch (error) {
    // Réseau tombé ou annulation : la copie s'arrête. Une fiche refusée (404, 403) n'arrête pas le reste, mais le
    // refus est compté (journal) : une session expirée (401) ne passe plus pour une copie réussie.
    if (isNetworkFailure(error) || (error as { name?: string }).name === "AbortError") throw error;
    const status = String((error as { status?: unknown }).status ?? "autre");
    tally.refused[status] = (tally.refused[status] ?? 0) + 1;
    return null;
  }
}

function journal(entry: Omit<JournalEntry, "at" | "copied" | "refused" | "durationMs">, started: number): void {
  addJournalEntry({ ...entry, at: started, copied: tally.copied, refused: { ...tally.refused }, durationMs: Date.now() - started });
}

/** Une étape de lectures fixes, avec son avancement. */
async function steps(phase: CopyPhase, paths: string[], signal: AbortSignal): Promise<void> {
  set({ phase, done: 0, total: paths.length });
  let done = 0;
  for (const path of paths) {
    await read(path, signal);
    set({ done: ++done });
    await sleep(pauseMs, signal);
  }
}

/** Fils copiés au plus (les plus récents d'abord) : borne la copie d'une boîte très chargée. */
const MAX_THREADS = 200;
const MAIL_DAYS_MS = 90 * 24 * 3600 * 1000;

async function copyMail(full: boolean, signal: AbortSignal): Promise<number> {
  type Folder = { id: string; isVirtual?: boolean };
  type Message = { threadId: string; receivedAt: string };
  const folders = ((await read("/api/emails/folders", signal)) as { folders?: Folder[] } | null)?.folders ?? [];
  const latest = new Map<string, string>();
  for (const folder of folders.filter((f) => !f.isVirtual && !f.id.startsWith("virtual:"))) {
    const page = (await read(`/api/emails/messages?folderId=${folder.id}&skip=0&take=50`, signal)) as { messages?: Message[] } | null;
    for (const m of page?.messages ?? []) {
      if (Date.now() - Date.parse(m.receivedAt) > MAIL_DAYS_MS) continue;
      const known = latest.get(m.threadId);
      if (!known || known < m.receivedAt) latest.set(m.threadId, m.receivedAt);
    }
  }
  const threads = [...latest.entries()].sort((a, b) => b[1].localeCompare(a[1])).slice(0, MAX_THREADS);
  set({ phase: "Messagerie", done: 0, total: threads.length });
  let done = 0;
  await pool(threads, signal, async ([id, at]) => {
    if (full || !(await upToDate(`/api/emails/${id}`, at))) await read(`/api/emails/${id}`, signal);
    set({ done: ++done });
  });
  return threads.length;
}

/**
 * Copie complète (toutes les fiches relues) ou incrémentale (seulement ce qui a changé). `visible` ouvre la fenêtre
 * de progression. Une seule copie à la fois : un second appel pendant une copie est ignoré.
 */
export async function runOfflineCopy(opts: { full: boolean; visible: boolean; trigger?: "auto" | "manuel" }): Promise<CopySummary | null> {
  const trigger = opts.trigger ?? "auto";
  const started = Date.now();
  if (state.running) return null;
  if (!offlineEnabled() || !isOnline()) {
    // Copie automatique hors ligne : rien à signaler. Demandée à la main : la raison est notée.
    if (trigger === "manuel") {
      tally = { copied: 0, refused: {} };
      journal({ trigger, mode: null, outcome: "non lancée", detail: offlineEnabled() ? "Pas de réseau." : "Mode hors ligne inactif sur cette adresse." }, started);
    }
    return null;
  }
  tally = { copied: 0, refused: {} };
  controller = new AbortController();
  const { signal } = controller;
  set({ running: true, visible: opts.visible, mode: opts.full ? "full" : "incremental", phase: "Clients", done: 0, total: 0, error: null });
  try {
    // Clients : liste, puis fiche, bloc-notes, projets et pièces de chaque client à copier. Le bloc-notes a sa propre
    // date : l'enregistrer ne change pas celle de la fiche.
    const clients = ((await read("/api/clients", signal)) as Listed[] | null) ?? [];
    const changedClients = new Set<string>();
    set({ phase: "Clients", done: 0, total: clients.length });
    let done = 0;
    await pool(clients, signal, async (c) => {
      if (opts.full || !(await upToDate(`/api/clients/${c.id}`, c.updatedAt))) {
        changedClients.add(c.id);
        await read(`/api/clients/${c.id}`, signal);
        await read(`/api/clients/${c.id}/projects`, signal);
        await read(`/api/clients/${c.id}/renewals`, signal);
        await read(`/api/clients/${c.id}/emails`, signal);
        await read(`/api/invoices?type=INVOICE&clientId=${c.id}`, signal);
        await read(`/api/invoices?clientId=${c.id}`, signal);
        await read(`/api/invoices?type=QUOTE&clientId=${c.id}`, signal);
      }
      if (opts.full || !(await upToDate(`/api/clients/${c.id}/notepad`, c.notepadUpdatedAt))) {
        await read(`/api/clients/${c.id}/notepad`, signal);
      }
      set({ done: ++done });
    });

    // Devis puis factures : liste, synthèse et détail de chaque pièce à copier.
    let quotes = 0;
    let invoices = 0;
    const listedDocs = new Set<string>();
    for (const [phase, type] of [["Devis", "QUOTE"], ["Factures", "INVOICE"]] as const) {
      const docs = ((await read(`/api/invoices?type=${type}`, signal)) as Listed[] | null) ?? [];
      await read(`/api/invoices/summary?type=${type}`, signal);
      if (type === "QUOTE") quotes = docs.length;
      else invoices = docs.length;
      set({ phase, done: 0, total: docs.length });
      let n = 0;
      await pool(docs, signal, async (d) => {
        listedDocs.add(d.id);
        if (opts.full || !(await upToDate(`/api/invoices/${d.id}`, d.updatedAt))) {
          await read(`/api/invoices/${d.id}`, signal);
          // Devis émis : son marché (jalons, acomptes, solde), affiché par la fiche du devis et de ses factures.
          if (type === "QUOTE" && (d as { number?: string | null }).number) await read(`/api/quotes/${d.id}/market`, signal);
          // Pièce modifiée : les listes de pièces de son client suivent (montants, statuts).
          if (!opts.full && d.clientId && !changedClients.has(d.clientId)) {
            changedClients.add(d.clientId);
            await read(`/api/invoices?clientId=${d.clientId}`, signal);
            await read(`/api/invoices?type=QUOTE&clientId=${d.clientId}`, signal);
          }
        }
        set({ done: ++n });
      });
    }

    // Prestations (lignes des packs comprises) et réglages (données d'appoint).
    const services = ((await read("/api/services", signal)) as Array<{ id: string; isPack?: boolean }> | null) ?? [];
    const packs = services.filter((s) => s.isPack);
    await steps("Prestations", ["/api/services?active=1", "/api/settings", ...packs.map((p) => `/api/services/${p.id}/pack-lines`)], signal);

    // Reste de l'ERP en lecture (décision du 19/10/2026) : pilotage, comptabilité, abonnements, réglages.
    const year = new Date().getFullYear();
    await steps("Pilotage", ["/api/dashboard/overview?scope=month", "/api/dashboard/overview?scope=quarter", "/api/dashboard/overview?scope=year", "/api/dashboard", "/api/emails/inbox-summary", "/api/notifications/feed", "/api/emails/sync-status"], signal);
    await steps("Comptabilité", ["/api/payments", "/api/invoices", `/api/receipts?year=${year}`, "/api/obligations", "/api/urssaf/declarations", "/api/owner-pay", "/api/stripe/flux"], signal);
    await steps("Abonnements", ["/api/subscriptions", "/api/services?subscription=1", "/api/services?active=1&subscription=1", "/api/subscriptions/revisions-to-attach"], signal);
    await steps("Réglages", ["/api/checklist", "/api/legal-clauses", "/api/numbering/preview", "/api/google/calendar/status"], signal);

    // Messagerie : dossiers, première page de chaque dossier, puis les fils des 90 derniers jours (texte seulement).
    // Un fil n'est relu que si un message plus récent que sa copie est arrivé (le serveur va chercher sur IMAP).
    const threads = await copyMail(opts.full, signal);

    // Fiches disparues du serveur : leurs copies (et ce qui en dépend) sont retirées.
    const clientIds = new Set(clients.map((c) => c.id));
    await deleteCopiesWhere((path) => {
      const client = /^\/api\/clients\/([A-Za-z0-9_-]+)(\/|$)/.exec(path)?.[1];
      if (client && !clientIds.has(client)) return true;
      const doc = /^\/api\/invoices\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
      return Boolean(doc && doc !== "summary" && doc !== "search" && !listedDocs.has(doc));
    });

    const summary: CopySummary = {
      at: Date.now(),
      clients: clients.length,
      quotes,
      invoices,
      services: services.length,
      threads,
      sizeBytes: await copiesSize().catch(() => null),
      format: SYNC_FORMAT,
      full: opts.full || Boolean(state.summary?.full),
    };
    writeSummary(summary);
    set({ running: false, phase: null, summary });
    journal({ trigger, mode: opts.full ? "full" : "incremental", outcome: "terminée", detail: refusalHint(tally.refused) }, started);
    if (opts.visible) notifyCopyDone(summary);
    return summary;
  } catch (error) {
    const aborted = (error as { name?: string }).name === "AbortError";
    const message = aborted ? "Copie annulée : elle reprendra au prochain passage en ligne." : "Réseau interrompu : la copie reprendra au retour du réseau.";
    set({ running: false, phase: null, error: message });
    journal({ trigger, mode: opts.full ? "full" : "incremental", outcome: aborted ? "annulée" : "interrompue", detail: message }, started);
    return null;
  } finally {
    controller = null;
  }
}

/** « 47 clients, 130 devis, 52 factures » : contenu de la copie, pour le toast, la notification et les Réglages. */
export function copyContents(s: CopySummary): string {
  const n = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;
  const parts = [n(s.clients, "client", "clients"), n(s.quotes, "devis", "devis"), n(s.invoices, "facture", "factures"), n(s.services, "prestation", "prestations")];
  if (s.threads) parts.push(n(s.threads, "fil de messages", "fils de messages"));
  return parts.join(", ");
}

/** Fin d'une copie suivie à l'écran : toast, et notification système si l'onglet est en arrière-plan. */
function notifyCopyDone(summary: CopySummary): void {
  const body = `Prêt hors ligne : ${copyContents(summary)}.`;
  toast.success("Copie hors ligne terminée", { description: body });
  if (!shouldNotifySystem() || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready
    .then((reg) => reg.showNotification("Copie hors ligne terminée", { body, tag: "copie-hors-ligne" }))
    .catch(() => undefined);
}

const AUTO_EVERY_MS = 15 * 60 * 1000;

/**
 * Copie automatique : à l'ouverture de l'ERP, au retour du réseau et toutes les 15 minutes. Première copie (ou format
 * changé) : complète, avec la fenêtre de progression ; ensuite, mises à jour silencieuses. Rend la fonction d'arrêt.
 */
export function startAutoOfflineCopy(): () => void {
  if (!offlineEnabled()) return () => undefined;
  void copyNow();
  // Retour du réseau : copie lancée par lib/reconnect, après la file et le rechargement de l'écran.
  const timer = window.setInterval(() => void copyNow(), AUTO_EVERY_MS);
  return () => window.clearInterval(timer);
}

/** Copie automatique maintenant : complète (avec l'indicateur) la première fois, sinon mise à jour silencieuse. */
export function copyNow(): Promise<CopySummary | null> {
  if (!isOnline() || state.running) return Promise.resolve(null);
  const first = needsFullCopy();
  return runOfflineCopy({ full: first || staleFullCopy(), visible: first });
}

/** Faut-il une copie complète (jamais faite, ou format changé) ? Sinon, une mise à jour incrémentale suffit. */
export function needsFullCopy(summary = state.summary): boolean {
  return !summary || summary.format !== SYNC_FORMAT || !summary.full;
}

/** Copie complète silencieuse si la dernière date de plus d'un jour (notes et projets n'ont pas d'updatedAt). */
export function staleFullCopy(summary = state.summary, now = Date.now()): boolean {
  return Boolean(summary && now - summary.at > FULL_EVERY_MS);
}

/** Message d'une fiche absente de la copie, avec l'avancement s'il y a une copie en cours. */
export function missingCopyMessage(what = "Cette fiche", s = state, feminine = true): string {
  if (s.running && s.phase) return `${what} n'est pas encore sur l'appareil (copie en cours, ${s.phase.toLowerCase()} ${s.done} sur ${s.total}).`;
  return `${what} n'est pas sur l'appareil : ${feminine ? "elle sera copiée" : "il sera copié"} au prochain passage en ligne.`;
}

/** Tests : état remis à zéro. */
export function resetOfflineCopyForTests(): void {
  controller = null;
  pauseMs = 0;
  state = { running: false, visible: false, mode: null, phase: null, done: 0, total: 0, error: null, summary: readSummary() };
}
