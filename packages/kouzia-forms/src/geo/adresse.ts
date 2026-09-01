import { sharedCache, TTL } from "../cache/memory-cache.js";
import {
  ADDRESS_SCORE_HIGH,
  ADDRESS_SCORE_MIN,
  type AdresseSuggestion,
  type AddressValidationResult,
  type ValidatedAddress,
} from "./types.js";

const BAN_BASE = "https://api-adresse.data.gouv.fr/search/";

export type SearchAdressesOptions = {
  postcode?: string;
  limit?: number;
  signal?: AbortSignal;
  cache?: { get: <T>(k: string) => T | undefined; set: <T>(k: string, v: T, ttl: number) => void };
};

type BanFeature = {
  properties?: {
    label?: string;
    name?: string;
    housenumber?: string;
    street?: string;
    postcode?: string;
    city?: string;
    citycode?: string;
    score?: number;
  };
  geometry?: {
    coordinates?: [number, number];
  };
};

function mapFeature(f: BanFeature): AdresseSuggestion | null {
  const p = f.properties;
  const coords = f.geometry?.coordinates;
  if (!p?.label || !p.postcode || !p.city || !p.citycode || !coords) return null;
  return {
    label: p.label,
    name: p.name ?? p.label,
    housenumber: p.housenumber ?? null,
    street: p.street ?? null,
    postcode: p.postcode,
    city: p.city,
    citycode: p.citycode,
    lon: coords[0],
    lat: coords[1],
    score: typeof p.score === "number" ? p.score : 0,
  };
}

function suggestionToValidated(s: AdresseSuggestion): ValidatedAddress {
  return {
    addressLine1: s.name,
    postalCode: s.postcode,
    city: s.city,
    citycode: s.citycode,
    lat: s.lat,
    lon: s.lon,
    score: s.score,
    label: s.label,
  };
}

/**
 * Autocomplétion BAN. Minimum 3 caractères recommandés côté appelant.
 * Retourne { unavailable: true } si l'API est injoignable.
 */
export async function searchAdresses(
  query: string,
  opts: SearchAdressesOptions = {},
): Promise<{ suggestions: AdresseSuggestion[]; unavailable: boolean }> {
  const q = query.trim();
  if (q.length < 3) return { suggestions: [], unavailable: false };

  const limit = opts.limit ?? 5;
  const postcode = opts.postcode?.replace(/\s/g, "") ?? "";
  const cache = opts.cache ?? sharedCache;
  const cacheKey = `adresse:${postcode}:${q.toLowerCase()}:${limit}`;
  const cached = cache.get<AdresseSuggestion[]>(cacheKey);
  if (cached) return { suggestions: cached, unavailable: false };

  try {
    const params = new URLSearchParams({
      q,
      autocomplete: "1",
      limit: String(limit),
    });
    if (/^\d{5}$/.test(postcode)) params.set("postcode", postcode);

    const res = await fetch(`${BAN_BASE}?${params}`, (() => {
      const init: RequestInit = { headers: { Accept: "application/json" } };
      if (opts.signal) init.signal = opts.signal;
      return init;
    })());
    if (!res.ok) return { suggestions: [], unavailable: true };

    const json = (await res.json()) as { features?: BanFeature[] };
    const suggestions = (json.features ?? [])
      .map(mapFeature)
      .filter((s): s is AdresseSuggestion => s !== null)
      .filter((s) => s.score >= ADDRESS_SCORE_MIN);

    cache.set(cacheKey, suggestions, TTL.ADRESSE);
    return { suggestions, unavailable: false };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return { suggestions: [], unavailable: true };
  }
}

/**
 * Revalide une adresse complète à la soumission.
 * - score élevé → normalisé
 * - plusieurs candidats proches → ambigu
 * - aucun → not_found
 * - API down → unavailable
 */
export async function validateAdresse(
  addressLine1: string,
  postalCode: string,
  city: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AddressValidationResult> {
  const parts = [addressLine1.trim(), postalCode.trim(), city.trim()].filter(Boolean);
  if (parts.length < 2) return { status: "not_found" };

  const q = parts.join(" ");
  try {
    const params = new URLSearchParams({ q, limit: "5" });
    const cp = postalCode.replace(/\s/g, "");
    if (/^\d{5}$/.test(cp)) params.set("postcode", cp);

    const res = await fetch(`${BAN_BASE}?${params}`, (() => {
      const init: RequestInit = { headers: { Accept: "application/json" } };
      if (opts.signal) init.signal = opts.signal;
      return init;
    })());
    if (!res.ok) return { status: "unavailable" };

    const json = (await res.json()) as { features?: BanFeature[] };
    const suggestions = (json.features ?? [])
      .map(mapFeature)
      .filter((s): s is AdresseSuggestion => s !== null);

    if (suggestions.length === 0) return { status: "not_found" };

    const best = suggestions[0]!;
    if (best.score >= ADDRESS_SCORE_HIGH) {
      return { status: "ok", address: suggestionToValidated(best) };
    }

    const close = suggestions.filter((s) => s.score >= ADDRESS_SCORE_MIN);
    if (close.length === 1 && close[0]!.score >= ADDRESS_SCORE_MIN) {
      // Un seul candidat moyen : on le propose sans forcer
      return { status: "ambiguous", suggestions: close };
    }
    if (close.length > 1) {
      return { status: "ambiguous", suggestions: close };
    }
    return { status: "not_found" };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return { status: "unavailable" };
  }
}

export { suggestionToValidated };
