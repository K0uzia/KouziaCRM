// Imports relatifs uniquement dans lib/offline : modules testés par vitest sans l'alias « @ ».
import { pendingCount, wipeOfflineData } from "./store";

/**
 * Options de la copie hors ligne propres à cet appareil (décision du 17/10/2026 : aucun effacement automatique par
 * défaut, des options par appareil dans les Réglages). Préférences légères gardées dans le navigateur, sans aucun
 * secret ; toute lecture ou écriture du stockage peut échouer (navigation privée) et revient aux valeurs par défaut.
 */
export type DeviceOptions = {
  /** À la déconnexion, effacer la copie (clé supprimée : la copie devient illisible). */
  wipeOnLogout: boolean;
  /** Effacer la copie après ce nombre de jours sans connexion au serveur ; null : jamais. */
  wipeAfterDays: number | null;
};

export const DEFAULT_DEVICE_OPTIONS: DeviceOptions = { wipeOnLogout: false, wipeAfterDays: null };
const OPTIONS_KEY = "kouzia:hors-ligne:options";
const LAST_ONLINE_KEY = "kouzia:hors-ligne:derniere-connexion";
const FAILURE_KEY = "kouzia:hors-ligne:echec-ecriture";
const DAY = 86_400_000;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : l'option reste celle par défaut */
  }
}

export function readDeviceOptions(): DeviceOptions {
  const saved = readJson<Partial<DeviceOptions>>(OPTIONS_KEY);
  const days = saved?.wipeAfterDays;
  return {
    wipeOnLogout: saved?.wipeOnLogout === true,
    wipeAfterDays: typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 365 ? days : null,
  };
}

export function writeDeviceOptions(options: DeviceOptions): void {
  writeJson(OPTIONS_KEY, options);
}

let lastMarked = 0;
/** Réponse du serveur reçue : date de la dernière connexion (écrite au plus une fois par minute). */
export function markOnline(now = Date.now()): void {
  if (now - lastMarked < 60_000) return;
  lastMarked = now;
  writeJson(LAST_ONLINE_KEY, now);
}

export function lastOnlineAt(): number | null {
  const at = readJson<number>(LAST_ONLINE_KEY);
  return typeof at === "number" ? at : null;
}

/** Échec d'écriture de la copie (quota atteint, stockage refusé) : affiché dans les Réglages. */
export function recordCopyFailure(error: unknown, now = Date.now()): void {
  const name = typeof error === "object" && error !== null && "name" in error ? String((error as { name: unknown }).name) : "";
  const message = name === "QuotaExceededError" ? "Espace de stockage plein" : "Écriture refusée par le navigateur";
  writeJson(FAILURE_KEY, { at: now, message });
}

export function readCopyFailure(): { at: number; message: string } | null {
  return readJson<{ at: number; message: string }>(FAILURE_KEY);
}

export function clearCopyFailure(): void {
  try {
    if (storage()?.getItem(FAILURE_KEY) !== null) storage()?.removeItem(FAILURE_KEY);
  } catch {
    /* rien à faire */
  }
}

export type WipeOutcome = "wiped" | "kept-pending" | "none";

/** Effacement, sauf s'il reste des créations à envoyer : elles ne sont jamais perdues sans confirmation. */
async function wipeUnlessPending(): Promise<WipeOutcome> {
  if ((await pendingCount()) > 0) return "kept-pending";
  await wipeOfflineData();
  clearCopyFailure();
  return "wiped";
}

/** Option « effacer après N jours sans connexion », appliquée à l'ouverture de l'ERP. */
export async function applyRetention(now = Date.now()): Promise<WipeOutcome> {
  const { wipeAfterDays } = readDeviceOptions();
  const last = lastOnlineAt();
  if (wipeAfterDays === null || last === null || now - last < wipeAfterDays * DAY) return "none";
  return wipeUnlessPending();
}

/** Option « effacer la copie à la déconnexion ». */
export async function wipeOnLogoutIfWanted(): Promise<WipeOutcome> {
  return readDeviceOptions().wipeOnLogout ? wipeUnlessPending() : "none";
}

/** Place utilisée, quota et stockage persistant (navigator.storage), null si le navigateur ne le dit pas. */
export async function storageStatus(): Promise<{ usage: number | null; quota: number | null; persisted: boolean | null } | null> {
  const nav = typeof navigator === "undefined" ? null : navigator.storage;
  if (!nav) return null;
  const [estimate, persisted] = await Promise.all([
    nav.estimate ? nav.estimate().catch(() => null) : Promise.resolve(null),
    nav.persisted ? nav.persisted().catch(() => null) : Promise.resolve(null),
  ]);
  return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted };
}
