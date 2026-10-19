import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isNetworkFailure, isOnline, onReconnect } from "@/lib/network";
import { offlineEnabled } from "./config";
import { COPY_FORMAT, COPY_SUMMARY_KEY, copiesSize, deleteCopiesWhere, readCopy } from "./store";

/**
 * Copie automatique complète pour le hors ligne (décision d'Alexandre du 19/10/2026). Sur l'origine du hors ligne
 * seulement, l'ERP lit en arrière-plan toute la liste fermée (lib/offline/rules) : clients et leurs fiches, notes,
 * projets et pièces, devis et factures avec leur détail, prestations. Chaque lecture passe par api(), qui chiffre
 * et range la copie comme une consultation : mêmes données, mêmes exclusions (ni paiements, ni messagerie, ni PDF,
 * ni preuves de signature, ni secrets). Ensuite, mise à jour incrémentale : une fiche n'est relue que si la liste
 * la dit modifiée depuis sa copie (updatedAt). Débit limité : deux lectures à la fois, une courte pause entre deux.
 */

export type CopyPhase = "Clients" | "Devis" | "Factures" | "Prestations";
export type CopySummary = {
  at: number;
  clients: number;
  quotes: number;
  invoices: number;
  services: number;
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
export const SYNC_FORMAT = COPY_FORMAT * 100 + 1;
const SUMMARY_KEY = COPY_SUMMARY_KEY;
const CONCURRENCY = 2;
const PAUSE_MS = 120;
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
      await sleep(PAUSE_MS, signal);
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

async function read(path: string, signal: AbortSignal): Promise<unknown> {
  try {
    return await api<unknown>(path, { signal });
  } catch (error) {
    // Réseau tombé ou annulation : la copie s'arrête. Une fiche refusée (404, 403) n'arrête pas le reste.
    if (isNetworkFailure(error) || (error as { name?: string }).name === "AbortError") throw error;
    return null;
  }
}

/**
 * Copie complète (toutes les fiches relues) ou incrémentale (seulement ce qui a changé). `visible` ouvre la fenêtre
 * de progression. Une seule copie à la fois : un second appel pendant une copie est ignoré.
 */
export async function runOfflineCopy(opts: { full: boolean; visible: boolean }): Promise<CopySummary | null> {
  if (state.running || !offlineEnabled() || !isOnline()) return null;
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

    // Prestations et réglages des devis (données d'appoint).
    set({ phase: "Prestations", done: 0, total: 3 });
    const services = ((await read("/api/services", signal)) as unknown[] | null) ?? [];
    set({ done: 1 });
    await read("/api/services?active=1", signal);
    set({ done: 2 });
    await read("/api/settings", signal);
    set({ done: 3 });

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
      sizeBytes: await copiesSize().catch(() => null),
      format: SYNC_FORMAT,
      full: opts.full || Boolean(state.summary?.full),
    };
    writeSummary(summary);
    set({ running: false, phase: null, summary });
    if (opts.visible) notifyCopyDone(summary);
    return summary;
  } catch (error) {
    const aborted = (error as { name?: string }).name === "AbortError";
    set({
      running: false,
      phase: null,
      error: aborted ? "Copie annulée : elle reprendra au prochain passage en ligne." : "Réseau interrompu : la copie reprendra au retour du réseau.",
    });
    return null;
  } finally {
    controller = null;
  }
}

/** « 47 clients, 130 devis, 52 factures » : contenu de la copie, pour le toast, la notification et les Réglages. */
export function copyContents(s: CopySummary): string {
  const n = (count: number, one: string, many: string) => `${count} ${count > 1 ? many : one}`;
  return [n(s.clients, "client", "clients"), n(s.quotes, "devis", "devis"), n(s.invoices, "facture", "factures"), n(s.services, "prestation", "prestations")].join(", ");
}

/** Fin d'une copie suivie à l'écran : toast, et notification système si l'onglet est en arrière-plan. */
function notifyCopyDone(summary: CopySummary): void {
  const body = `Prêt hors ligne : ${copyContents(summary)}.`;
  toast.success("Copie hors ligne terminée", { description: body });
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !("serviceWorker" in navigator)) return;
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
  const tick = () => {
    if (!isOnline() || state.running) return;
    const first = needsFullCopy();
    void runOfflineCopy({ full: first || staleFullCopy(), visible: first });
  };
  tick();
  const stop = onReconnect(tick);
  const timer = window.setInterval(tick, AUTO_EVERY_MS);
  return () => {
    stop();
    window.clearInterval(timer);
  };
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
  state = { running: false, visible: false, mode: null, phase: null, done: 0, total: 0, error: null, summary: readSummary() };
}
