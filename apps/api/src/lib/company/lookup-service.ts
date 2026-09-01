import { sharedCache, TTL } from "@kouzia/forms";
import { fetchCompanyFromOpenData, type InpiImportResult } from "@/lib/company/inpi.js";

/**
 * Payload renvoyé aux formulaires clients (ERP + Kouzia).
 * Même source que Paramètres > Import INPI (`fetchCompanyFromOpenData`).
 */
export type EntrepriseApiPayload = InpiImportResult & {
  verifiedAt: string;
  /** Alias pour le front CompanyLookup (même valeur que legalName). */
  companyName: string | null;
};

/** Lookup entreprise avec cache serveur (limite ~7 req/s de l'API gouv). */
export async function lookupEntrepriseCached(
  sirenOrSiretOrUrl: string,
): Promise<
  | { ok: true; data: EntrepriseApiPayload }
  | { ok: false; reason: "invalid_siren" | "not_found" | "unavailable" }
> {
  const digits = sirenOrSiretOrUrl.replace(/\D/g, "");
  const cacheKey = `api:entreprise:${digits.slice(0, 14) || sirenOrSiretOrUrl}`;
  const cached = sharedCache.get<EntrepriseApiPayload>(cacheKey);
  if (cached) return { ok: true, data: cached };

  try {
    const imported = await fetchCompanyFromOpenData(sirenOrSiretOrUrl);
    const data: EntrepriseApiPayload = {
      ...imported,
      companyName: imported.legalName,
      verifiedAt: new Date().toISOString(),
    };
    sharedCache.set(cacheKey, data, TTL.ENTREPRISE);
    return { ok: true, data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/introuvable|Aucune entreprise/i.test(msg)) {
      return { ok: false, reason: "not_found" };
    }
    if (/SIREN invalide|SIREN introuvable/i.test(msg)) {
      return { ok: false, reason: "invalid_siren" };
    }
    return { ok: false, reason: "unavailable" };
  }
}
