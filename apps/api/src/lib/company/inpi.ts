import { lookupEntreprise } from "@kouzia/forms";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import { parseBusinessStartDateInput } from "@/lib/company/business-start.js";
import { prisma } from "@/lib/prisma.js";

export type InpiImportResult = {
  siren: string;
  siret: string | null;
  legalName: string | null;
  tradeName: string | null;
  apeCode: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  city: string | null;
  citycode: string | null;
  country: string;
  legalForm: string | null;
  rneRegistrationDate: string | null;
  businessStartDate: string | null;
  inpiUrl: string;
  redacted: boolean;
  warnings: string[];
};

/** Extrait un SIREN depuis une URL data.inpi.fr ou une saisie libre. */
export function extractSiren(input: string): string | null {
  const raw = input.trim();
  const fromUrl = raw.match(/(\d{9})(?:\D|$)/);
  if (fromUrl) return fromUrl[1] ?? null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 9) return digits;
  if (digits.length === 14) return digits.slice(0, 9);
  return null;
}

function cleanIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || v.includes("NON-DIFFUSIBLE")) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1]! : null;
}

/** Dates RNE / début d'activité depuis la réponse recherche-entreprises. */
export function extractCompanyDates(
  hit: Record<string, unknown>,
  siege: Record<string, unknown>,
): { rneRegistrationDate: string | null; businessStartDate: string | null } {
  const rneRegistrationDate =
    cleanIsoDate(hit.date_mise_a_jour_rne) ??
    cleanIsoDate(siege.date_mise_a_jour_rne) ??
    cleanIsoDate(hit.date_creation) ??
    cleanIsoDate(siege.date_creation);

  const businessStartDate =
    cleanIsoDate(siege.date_debut_activite) ??
    cleanIsoDate(hit.date_debut_activite) ??
    cleanIsoDate(siege.date_creation) ??
    cleanIsoDate(hit.date_creation);

  return { rneRegistrationDate, businessStartDate };
}

/**
 * Source unique de vérité pour Settings (import INPI) et formulaires clients.
 * S'appuie sur l'API Recherche d'entreprises (même pipeline que Paramètres > Identité).
 */
export async function fetchCompanyFromOpenData(sirenOrUrl: string): Promise<InpiImportResult> {
  const siren = extractSiren(sirenOrUrl);
  if (!siren) {
    throw new Error("SIREN introuvable (9 chiffres ou URL data.inpi.fr)");
  }

  const inpiUrl = sirenOrUrl.includes("inpi.fr")
    ? sirenOrUrl.trim()
    : `https://data.inpi.fr/entreprises/${siren}`;

  const result = await lookupEntreprise(sirenOrUrl);
  if (!result.ok) {
    if (result.reason === "not_found") {
      throw new Error(`Aucune entreprise trouvée pour le SIREN ${siren}`);
    }
    if (result.reason === "invalid_siren") {
      throw new Error("SIREN invalide");
    }
    throw new Error("API entreprises indisponible");
  }

  const e = result.entreprise;
  const warnings = [...e.warnings];
  if (!e.creationDate) {
    warnings.push(
      "Date de début d'activité absente de l'open data : saisissez-la manuellement si besoin.",
    );
  }

  // Raison sociale affichée : priorité à la dénomination, sinon enseigne
  const displayName = e.legalName ?? e.tradeName;

  return {
    siren: e.siren,
    siret: e.siret,
    legalName: displayName,
    tradeName: e.tradeName,
    apeCode: e.apeCode,
    addressLine1: e.addressLine1,
    postalCode: e.postalCode,
    city: e.city,
    citycode: e.citycode,
    country: e.country,
    legalForm: e.legalForm,
    rneRegistrationDate: e.creationDate,
    businessStartDate: e.creationDate,
    inpiUrl,
    redacted: e.redacted,
    warnings,
  };
}

/** Applique l'import INPI/open data sur CompanySettings (ne remplace pas par null). */
export async function applyInpiImport(sirenOrUrl: string) {
  const imported = await fetchCompanyFromOpenData(sirenOrUrl);
  const current = await getCompanySettings();

  const updated = await prisma.companySettings.update({
    where: { id: current.id },
    data: {
      siren: imported.siren,
      siret: imported.siret ?? current.siret,
      // Ne jamais écraser une valeur existante par null (EI non diffusibles)
      legalName: imported.legalName ?? current.legalName,
      tradeName: imported.tradeName ?? current.tradeName,
      apeCode: imported.apeCode ?? current.apeCode,
      addressLine1: imported.addressLine1 ?? current.addressLine1,
      postalCode: imported.postalCode ?? current.postalCode,
      city: imported.city ?? current.city,
      country: imported.country,
      rneRegistrationDate: imported.rneRegistrationDate
        ? parseBusinessStartDateInput(imported.rneRegistrationDate)
        : current.rneRegistrationDate,
      businessStartDate: imported.businessStartDate
        ? parseBusinessStartDateInput(imported.businessStartDate)
        : current.businessStartDate,
      inpiUrl: imported.inpiUrl,
    },
  });
  invalidateCompanySettingsCache();
  return { settings: updated, import: imported };
}
