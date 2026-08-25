import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
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
  country: string;
  businessStartDate: string | null;
  inpiUrl: string;
  redacted: boolean;
  warnings: string[];
};

function isRedacted(value: unknown): boolean {
  return typeof value === "string" && value.includes("NON-DIFFUSIBLE");
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || isRedacted(v)) return null;
  return v;
}

/** Extrait un SIREN depuis une URL data.inpi.fr ou une saisie libre. */
export function extractSiren(input: string): string | null {
  const raw = input.trim();
  const fromUrl = raw.match(/(\d{9})(?:\D|$)/);
  if (fromUrl) return fromUrl[1];
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 9) return digits;
  if (digits.length === 14) return digits.slice(0, 9);
  return null;
}

export async function fetchCompanyFromOpenData(sirenOrUrl: string): Promise<InpiImportResult> {
  const siren = extractSiren(sirenOrUrl);
  if (!siren) {
    throw new Error("SIREN introuvable (9 chiffres ou URL data.inpi.fr)");
  }

  const inpiUrl =
    sirenOrUrl.includes("inpi.fr")
      ? sirenOrUrl.trim()
      : `https://data.inpi.fr/entreprises/${siren}`;

  const res = await fetch(
    `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(siren)}&per_page=1`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`API entreprises indisponible (${res.status})`);
  }
  const json = (await res.json()) as {
    results?: Array<Record<string, unknown>>;
  };
  const hit = json.results?.[0];
  if (!hit || String(hit.siren) !== siren) {
    throw new Error(`Aucune entreprise trouvée pour le SIREN ${siren}`);
  }

  const siege = (hit.siege ?? {}) as Record<string, unknown>;
  const warnings: string[] = [];
  const redacted =
    isRedacted(hit.nom_complet) ||
    isRedacted(siege.adresse) ||
    String(siege.statut_diffusion_etablissement ?? "") === "P";

  if (redacted) {
    warnings.push(
      "Entreprise à diffusion partielle (EI) : certains champs sont masqués par l'open data. Les valeurs déjà en base sont conservées.",
    );
  }

  const streetParts = [
    clean(siege.numero_voie),
    clean(siege.type_voie),
    clean(siege.libelle_voie),
  ].filter(Boolean);

  return {
    siren,
    siret: clean(siege.siret) ?? (typeof siege.siret === "string" ? siege.siret : null),
    legalName: clean(hit.nom_raison_sociale) ?? clean(hit.nom_complet),
    tradeName: clean(siege.nom_commercial) ?? clean(hit.sigle),
    apeCode: clean(hit.activite_principale) ?? clean(siege.activite_principale),
    addressLine1: streetParts.length ? streetParts.join(" ") : clean(siege.geo_adresse),
    postalCode: clean(siege.code_postal),
    city: clean(siege.libelle_commune),
    country: "FRANCE",
    businessStartDate:
      clean(hit.date_creation) ??
      clean(siege.date_creation) ??
      clean(siege.date_debut_activite),
    inpiUrl,
    redacted,
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
      legalName: imported.legalName ?? current.legalName,
      tradeName: imported.tradeName ?? current.tradeName,
      apeCode: imported.apeCode ?? current.apeCode,
      addressLine1: imported.addressLine1 ?? current.addressLine1,
      postalCode: imported.postalCode ?? current.postalCode,
      city: imported.city ?? current.city,
      country: imported.country,
      // Ne pas écraser une date déjà saisie (open data EI souvent incomplet / trompeur)
      businessStartDate:
        current.businessStartDate ??
        (imported.businessStartDate ? new Date(imported.businessStartDate) : null),
      inpiUrl: imported.inpiUrl,
    },
  });
  invalidateCompanySettingsCache();
  return { settings: updated, import: imported };
}
