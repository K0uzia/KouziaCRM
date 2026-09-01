import { sharedCache, TTL } from "../cache/memory-cache.js";
import { isValidSiren } from "../validation/luhn.js";
import { normalizeDigits } from "../validation/siren-siret.js";

export type EntrepriseLookupResult = {
  siren: string;
  siret: string | null;
  legalName: string | null;
  tradeName: string | null;
  /** Forme juridique (libellé) */
  legalForm: string | null;
  apeCode: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  city: string | null;
  citycode: string | null;
  country: string;
  creationDate: string | null;
  redacted: boolean;
  warnings: string[];
};

export type LookupEntrepriseOptions = {
  signal?: AbortSignal;
  cache?: { get: <T>(k: string) => T | undefined; set: <T>(k: string, v: T, ttl: number) => void };
};

/** Codes nature juridique courants (INSEE) → libellé court. */
const LEGAL_FORMS: Record<string, string> = {
  "1000": "Entrepreneur individuel",
  "5499": "SARL",
  "5710": "SAS",
  "5720": "SASU",
  "5498": "EURL",
  "5202": "Société en nom collectif",
  "5308": "Société en commandite simple",
  "5800": "Société européenne",
  "9220": "Association déclarée",
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

function cleanIsoDate(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return m ? m[1]! : null;
}

function legalFormLabel(hit: Record<string, unknown>): string | null {
  const code = clean(hit.nature_juridique);
  const libelle = clean(hit.libelle_nature_juridique);
  if (libelle) return libelle;
  if (code && LEGAL_FORMS[code]) return LEGAL_FORMS[code]!;
  return code;
}

/** Enrichit CP / nom de ville depuis le code INSEE commune (geo.api.gouv.fr). */
async function enrichFromCitycode(
  citycode: string,
  signal?: AbortSignal,
): Promise<{ postalCode: string | null; city: string | null }> {
  try {
    const init: RequestInit = { headers: { Accept: "application/json" } };
    if (signal) init.signal = signal;
    const res = await fetch(
      `https://geo.api.gouv.fr/communes/${encodeURIComponent(citycode)}?fields=nom,codesPostaux`,
      init,
    );
    if (!res.ok) return { postalCode: null, city: null };
    const json = (await res.json()) as { nom?: string; codesPostaux?: string[] };
    return {
      city: json.nom?.trim() || null,
      postalCode: json.codesPostaux?.[0] ?? null,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return { postalCode: null, city: null };
  }
}

/**
 * Recherche une entreprise via l'API Recherche d'entreprises (gratuite, sans clé).
 * Ne pas utiliser entreprise.api.gouv.fr (réservée aux administrations).
 * Accepte un SIREN (9) ou un SIRET (14) : le SIREN est dérivé des 9 premiers chiffres.
 */
export async function lookupEntreprise(
  sirenOrSiret: string,
  opts: LookupEntrepriseOptions = {},
): Promise<
  | { ok: true; entreprise: EntrepriseLookupResult }
  | { ok: false; reason: "invalid_siren" | "not_found" | "unavailable" }
> {
  const digits = normalizeDigits(sirenOrSiret);
  const siren = digits.length === 14 ? digits.slice(0, 9) : digits;
  const inputSiret = digits.length === 14 ? digits : null;
  if (!isValidSiren(siren)) {
    return { ok: false, reason: "invalid_siren" };
  }

  const cache = opts.cache ?? sharedCache;
  const cacheKey = `entreprise:${siren}`;
  const cached = cache.get<EntrepriseLookupResult>(cacheKey);
  if (cached) {
    // Conserve le SIRET saisi s'il est plus précis que le cache
    if (inputSiret && !cached.siret) {
      return { ok: true, entreprise: { ...cached, siret: inputSiret } };
    }
    return { ok: true, entreprise: cached };
  }

  try {
    const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(siren)}&per_page=1`;
    const init: RequestInit = { headers: { Accept: "application/json" } };
    if (opts.signal) init.signal = opts.signal;
    const res = await fetch(url, init);
    if (!res.ok) return { ok: false, reason: "unavailable" };

    const json = (await res.json()) as {
      results?: Array<Record<string, unknown>>;
    };
    const hit = json.results?.[0];
    if (!hit || String(hit.siren) !== siren) {
      return { ok: false, reason: "not_found" };
    }

    const siege = (hit.siege ?? {}) as Record<string, unknown>;
    const warnings: string[] = [];
    const redacted =
      isRedacted(hit.nom_complet) ||
      isRedacted(siege.adresse) ||
      String(siege.statut_diffusion_etablissement ?? "") === "P";

    if (redacted) {
      warnings.push(
        "Entrepreneur individuel ou diffusion partielle : la raison sociale et l'adresse ne sont pas diffusées par l'open data. Saisissez-les manuellement.",
      );
    }

    const streetParts = [
      clean(siege.numero_voie),
      clean(siege.type_voie),
      clean(siege.libelle_voie),
    ].filter(Boolean);

    const creationDate =
      cleanIsoDate(siege.date_creation) ??
      cleanIsoDate(hit.date_creation) ??
      cleanIsoDate(siege.date_debut_activite);

    let postalCode = clean(siege.code_postal);
    let city = clean(siege.libelle_commune);
    const citycode = clean(siege.commune) ?? clean(siege.code_commune);

    // Si le CP est masqué mais le code INSEE est connu, on le récupère via geo.api.gouv.fr
    if (citycode && (!postalCode || !city)) {
      const geo = await enrichFromCitycode(citycode, opts.signal);
      postalCode = postalCode ?? geo.postalCode;
      city = city ?? geo.city;
    }

    const siretFromApi =
      clean(siege.siret) ??
      (typeof siege.siret === "string" && !isRedacted(siege.siret) ? siege.siret : null);

    const entreprise: EntrepriseLookupResult = {
      siren,
      siret: siretFromApi ?? inputSiret,
      legalName: clean(hit.nom_raison_sociale) ?? clean(hit.nom_complet),
      tradeName: clean(siege.nom_commercial) ?? clean(hit.sigle),
      legalForm: legalFormLabel(hit),
      apeCode: clean(hit.activite_principale) ?? clean(siege.activite_principale),
      addressLine1: streetParts.length ? streetParts.join(" ") : clean(siege.geo_adresse),
      postalCode,
      city,
      citycode,
      country: "FRANCE",
      creationDate,
      redacted,
      warnings,
    };

    cache.set(cacheKey, entreprise, TTL.ENTREPRISE);
    return { ok: true, entreprise };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return { ok: false, reason: "unavailable" };
  }
}
