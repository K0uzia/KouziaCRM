import type { FastifyRequest } from "fastify";

/**
 * Chemin tel que le routeur l'a compris (audit du 27/10/2026) : le motif de la route trouvée (« /api/promo-codes/:id »),
 * à défaut le chemin décodé. Le routeur décode les %XX : une garde qui lisait request.url (brute) se contournait par
 * « /api/%70romo-codes » ou « /%61pi/… ». Toute décision de garde sur le chemin passe par ici.
 */
export function routePath(request: FastifyRequest): string {
  const pattern = request.routeOptions?.url;
  // Route générique (« * » : préflight CORS, fichiers) : son motif ne dit rien du chemin, on juge le chemin décodé.
  if (pattern && !pattern.includes("*")) return pattern;
  const raw = request.url.split("?")[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    // %XX mal formé : le routeur le refuse aussi ; on juge le brut
    return raw;
  }
}
