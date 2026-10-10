import { getCompanySettings } from "@/lib/company.js";

/**
 * URL du portail client (Paramètres > Entreprise, puis CLIENT_PORTAL_URL, puis origine publique + /suivi/).
 * Toujours avec une barre finale : le site (Astro, trailingSlash « always ») sert /suivi/ sans redirection.
 */
export async function resolveClientPortalUrl(): Promise<string> {
  const settings = await getCompanySettings();
  const fromDb = settings.clientPortalUrl?.trim();
  if (fromDb) return withTrailingSlash(fromDb);

  const fromEnv = process.env.CLIENT_PORTAL_URL?.trim();
  if (fromEnv) return withTrailingSlash(fromEnv);

  const origin =
    process.env.PUBLIC_WEB_ORIGIN?.trim() ||
    process.env.WEB_ORIGIN?.trim() ||
    "http://localhost:5174";
  return `${origin.replace(/\/+$/, "")}/suivi/`;
}

function withTrailingSlash(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}
