/**
 * Origine du mode hors ligne de l'admin, réécrite dans index.html à chaque service de la page : la SPA ne garde
 * de copie locale (et le service worker ne met en cache les écrans) que sur cette origine. Valeur d'exécution
 * (ADMIN_PUBLIC_ORIGIN du .env) : elle remplace celle écrite au build. Absente ou invalide : balise vide, hors
 * ligne désactivé partout.
 */
export function offlineOriginOf(value: string | undefined): string {
  if (!value?.trim()) return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : "";
  } catch {
    return "";
  }
}

export function withOfflineOrigin(html: string, configured: string | undefined): string {
  const origin = offlineOriginOf(configured);
  return html.replace(/(<meta name="kouzia-offline-origin" content=")[^"]*(")/, (_m, start: string, end: string) => `${start}${origin}${end}`);
}
