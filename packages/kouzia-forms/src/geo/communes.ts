import { sharedCache, TTL } from "../cache/memory-cache.js";
import type { Commune } from "./types.js";

const GEO_BASE = "https://geo.api.gouv.fr/communes";

export type FetchCommunesOptions = {
  signal?: AbortSignal;
  cache?: { get: <T>(k: string) => T | undefined; set: <T>(k: string, v: T, ttl: number) => void };
};

/**
 * Recherche les communes associées à un code postal français (5 chiffres).
 * Retourne [] si le CP est invalide ou si l'API est injoignable (dégradation).
 */
export async function fetchCommunesByPostalCode(
  codePostal: string,
  opts: FetchCommunesOptions = {},
): Promise<{ communes: Commune[]; unavailable: boolean }> {
  const cp = codePostal.replace(/\s/g, "");
  if (!/^\d{5}$/.test(cp)) {
    return { communes: [], unavailable: false };
  }

  const cache = opts.cache ?? sharedCache;
  const cacheKey = `communes:${cp}`;
  const cached = cache.get<Commune[]>(cacheKey);
  if (cached) return { communes: cached, unavailable: false };

  try {
    const url = `${GEO_BASE}?codePostal=${encodeURIComponent(cp)}&fields=nom,codesPostaux,code`;
    const init: RequestInit = { headers: { Accept: "application/json" } };
    if (opts.signal) init.signal = opts.signal;
    const res = await fetch(url, init);
    if (!res.ok) {
      return { communes: [], unavailable: true };
    }
    const raw = (await res.json()) as Array<{
      nom?: string;
      code?: string;
      codesPostaux?: string[];
    }>;
    const communes: Commune[] = raw
      .filter((c) => c.nom && c.code)
      .map((c) => ({
        nom: c.nom!,
        code: c.code!,
        codesPostaux: Array.isArray(c.codesPostaux) ? c.codesPostaux : [cp],
      }));
    cache.set(cacheKey, communes, TTL.COMMUNES);
    return { communes, unavailable: false };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    return { communes: [], unavailable: true };
  }
}
