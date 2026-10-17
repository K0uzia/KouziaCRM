import { useSyncExternalStore } from "react";
import { toast } from "sonner";

// Imports relatifs uniquement : ce module est testé par vitest sans l'alias « @ » de Vite.

export const OFFLINE_MESSAGE = "Pas de connexion. Réessayez dès le retour du réseau.";
/** Identifiant sonner fixe : un seul toast hors ligne à l'écran, quel que soit le nombre d'appels échoués. */
export const OFFLINE_TOAST_ID = "hors-ligne";

/** Requête impossible faute de réseau (ou serveur injoignable) : jamais une réponse du serveur. */
export class OfflineError extends Error {
  readonly code = "offline" as const;
  readonly offline = true;
  constructor() {
    super(OFFLINE_MESSAGE);
    this.name = "OfflineError";
  }
}

export function isOfflineError(error: unknown): error is OfflineError {
  return error instanceof OfflineError || (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "offline");
}

/** Échec réseau brut de fetch, selon le moteur (Chromium, Firefox, WebKit). */
export function isNetworkFailure(error: unknown): boolean {
  if (isOfflineError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|Network request failed)$/i.test(message.trim());
}

/** Message affichable : un échec réseau brut (en anglais) devient le message hors ligne. */
export function errorMessage(error: unknown, fallback: string): string {
  if (isNetworkFailure(error)) return OFFLINE_MESSAGE;
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Module d'une page introuvable : version remplacée pendant que l'onglet était ouvert, ou réseau coupé. */
export function isStaleChunk(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(message);
}

export function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/** État du réseau d'après le navigateur, mis à jour aux événements online et offline. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}

/** Rappel au retour du réseau : les relevés périodiques reprennent sans attendre leur prochain cycle. */
export function onReconnect(callback: () => void): () => void {
  window.addEventListener("online", callback);
  return () => window.removeEventListener("online", callback);
}

/** Le serveur répond-il ? navigator.onLine peut être vrai sans accès réel (Wi-Fi sans Internet, VPN coupé). */
export async function serverReachable(timeoutMs = 4000): Promise<boolean> {
  if (!isOnline()) return false;
  try {
    const res = await fetch("/api/health", { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Toasts d'erreur : un échec réseau, affiché seul ou en suffixe (« Besoins non enregistrés : … »), devient le
 * message hors ligne sous un identifiant fixe. Écrit ici plutôt qu'à chaque appel toast.error des écrans :
 * sonner n'offre pas de déduplication par contenu.
 */
export function installOfflineToasts(): void {
  const original = toast.error;
  if ((original as { offlineAware?: boolean }).offlineAware) return;
  const patched: typeof toast.error = (message, data) => {
    const text = typeof message === "string" ? message : "";
    const offline = text.includes(OFFLINE_MESSAGE) || /(^|: )(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed)$/i.test(text);
    if (offline) return original(OFFLINE_MESSAGE, { ...data, id: OFFLINE_TOAST_ID });
    return original(message, data);
  };
  Object.assign(patched, { offlineAware: true });
  toast.error = patched;
}
