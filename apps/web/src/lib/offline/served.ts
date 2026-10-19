import { useSyncExternalStore } from "react";

/**
 * Lectures servies depuis la copie locale, par écran (chemin de la page au moment de la requête). Une réponse
 * fraîche du serveur retire l'entrée : la mention de date disparaît dès que l'écran est relu en ligne.
 */
type Entry = { savedAt: number; route: string };
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version++;
  for (const listener of listeners) listener();
}

export function markServedFromCopy(apiPath: string, savedAt: number, route: string): void {
  entries.set(apiPath, { savedAt, route });
  emit();
}

export function markFresh(apiPath: string): void {
  const served = entries.delete(apiPath);
  const wasMissing = missing.delete(apiPath);
  if (served || wasMissing) emit();
}

/**
 * Lectures d'un écran absentes de l'appareil (hors ligne, pas de copie). Lectures communes à tous les écrans
 * (session, notifications, état de la messagerie, réglages) exclues : seules comptent celles de l'écran.
 */
const missing = new Map<string, string>();
const SHARED = /^\/api\/(auth\/|notifications\/|emails\/sync-status$|settings$|health$)/;

export function markMissing(apiPath: string, route: string): void {
  if (SHARED.test(apiPath) || missing.get(apiPath) === route) return;
  missing.set(apiPath, route);
  emit();
}

/** Écran sans aucune donnée sur l'appareil : au moins une lecture absente, et rien servi depuis la copie. */
export function pageMissingFor(route: string): boolean {
  if (copyDateFor(route) !== null) return false;
  for (const r of missing.values()) if (r === route) return true;
  return false;
}

export function usePageMissing(route: string): boolean {
  useSyncExternalStore(subscribe, () => version, () => version);
  return pageMissingFor(route);
}

/** Écran rechargé (retour du réseau) : ses lectures absentes sont oubliées. */
export function forgetMissing(route: string): void {
  let changed = false;
  for (const [path, r] of missing) {
    if (r === route) {
      missing.delete(path);
      changed = true;
    }
  }
  if (changed) emit();
}

/** Date de la plus ancienne donnée affichée sur cet écran depuis la copie, ou null. */
export function copyDateFor(route: string): number | null {
  let oldest: number | null = null;
  for (const entry of entries.values()) {
    if (entry.route === route && (oldest === null || entry.savedAt < oldest)) oldest = entry.savedAt;
  }
  return oldest;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCopyDate(route: string): number | null {
  useSyncExternalStore(subscribe, () => version, () => version);
  return copyDateFor(route);
}

const two = (n: number) => String(n).padStart(2, "0");

/** « Données du 17/10 à 14 h 05 » (heure locale). */
export function formatCopyDate(savedAt: number): string {
  const d = new Date(savedAt);
  return `Données du ${two(d.getDate())}/${two(d.getMonth() + 1)} à ${two(d.getHours())} h ${two(d.getMinutes())}`;
}

/** Tests : état vide. */
export function resetServedForTests(): void {
  entries.clear();
  missing.clear();
  emit();
}

const copies = new WeakMap<object, number>();

/** Marque une réponse servie depuis la copie (objet ou liste). */
export function tagCopy<T>(data: T, savedAt: number): T {
  if (data && typeof data === "object") copies.set(data, savedAt);
  return data;
}

/** Date de copie d'une réponse, ou null si elle vient du serveur. L'écran Réglages refuse une copie partielle. */
export function copiedAt(data: unknown): number | null {
  return data && typeof data === "object" ? (copies.get(data) ?? null) : null;
}
