// Imports relatifs uniquement dans lib/offline : modules testés par vitest sans l'alias « @ ».
import { useSyncExternalStore } from "react";

/**
 * Journal de diagnostic de la copie hors ligne, affiché dans Réglages > Cet appareil : chaque tentative (lancée ou
 * non, et pourquoi), son issue, le nombre de lectures copiées et refusées par statut HTTP. Des nombres, des dates et
 * des messages de l'ERP seulement : aucune donnée de client, aucun chemin d'API. Gardé dans ce navigateur (10 entrées).
 */
export type JournalOutcome = "terminée" | "annulée" | "interrompue" | "non lancée";
export type JournalEntry = {
  at: number;
  trigger: "auto" | "manuel";
  mode: "full" | "incremental" | null;
  outcome: JournalOutcome;
  /** Raison d'une copie non lancée ou interrompue, ou avertissement d'une copie terminée avec des refus. */
  detail: string | null;
  copied: number;
  /** Lectures refusées par le serveur, par statut (« 401 » : 3). */
  refused: Record<string, number>;
  durationMs: number;
};

const KEY = "kouzia:hors-ligne:journal";
const MAX = 10;
let entries: JournalEntry[] = load();
const listeners = new Set<() => void>();

function load(): JournalEntry[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as JournalEntry[]).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function addJournalEntry(entry: JournalEntry): void {
  entries = [entry, ...entries].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* navigation privée : le journal reste en mémoire */
  }
  for (const l of listeners) l();
}

export function readJournal(): JournalEntry[] {
  return entries;
}

export function useCopyJournal(): JournalEntry[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => entries,
    () => entries,
  );
}

/** « 2 refus (401 : 2) » : lecture humaine des refus, vide s'il n'y en a pas. */
export function refusedText(refused: Record<string, number>): string {
  const total = Object.values(refused).reduce((a, b) => a + b, 0);
  if (!total) return "";
  const parts = Object.entries(refused).map(([status, n]) => `${status} : ${n}`);
  return `${total} refus (${parts.join(", ")})`;
}

/** Statut HTTP lu comme une explication pour Alexandre. */
export function refusalHint(refused: Record<string, number>): string | null {
  if (refused["401"]) return "Session expirée pendant la copie : reconnectez-vous puis relancez-la.";
  if (refused["429"]) return "Trop de lectures à la suite (limite de débit) : la copie reprendra plus tard.";
  if (Object.keys(refused).some((s) => s.startsWith("5"))) return "Le serveur a répondu en erreur à certaines lectures.";
  if (refused["403"]) return "Lectures refusées par le serveur (403).";
  return null;
}

/** Tests : journal vidé. */
export function resetJournalForTests(): void {
  entries = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* sans stockage */
  }
}
