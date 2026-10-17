// Imports relatifs uniquement dans lib/offline : modules testés par vitest sans l'alias « @ ».

/** Balise remplie au build (ADMIN_PUBLIC_ORIGIN) et réécrite par l'API à chaque service d'index.html. */
export const OFFLINE_ORIGIN_META = "kouzia-offline-origin";

/** Origine autorisée à garder une copie locale (erp.kouzia.com), lue dans la configuration, jamais en dur. */
export function configuredOfflineOrigin(): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.querySelector<HTMLMetaElement>(`meta[name="${OFFLINE_ORIGIN_META}"]`)?.content.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Mode hors ligne (copie chiffrée, service worker de l'application) : seulement sur l'origine configurée.
 * Ailleurs (Tailscale, LAN, dev), rien n'est copié et le service worker ne garde aucun fichier.
 */
export function offlineEnabled(): boolean {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return false;
  if (!window.isSecureContext || !globalThis.crypto?.subtle) return false;
  const origin = configuredOfflineOrigin();
  return origin !== null && origin === window.location.origin;
}
