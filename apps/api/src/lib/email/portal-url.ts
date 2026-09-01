import { getCompanySettings } from "@/lib/company.js";

/** URL du portail client (Paramètres > Entreprise, puis CLIENT_PORTAL_URL, puis origine publique + /suivi). */
export async function resolveClientPortalUrl(): Promise<string> {
  const settings = await getCompanySettings();
  const fromDb = settings.clientPortalUrl?.trim();
  if (fromDb) return fromDb.replace(/\/$/, "");

  const fromEnv = process.env.CLIENT_PORTAL_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  const origin =
    process.env.PUBLIC_WEB_ORIGIN?.trim() ||
    process.env.WEB_ORIGIN?.trim() ||
    "http://localhost:5174";
  return `${origin.replace(/\/$/, "")}/suivi`;
}
