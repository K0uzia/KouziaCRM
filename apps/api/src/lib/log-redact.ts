import type { FastifyRequest } from "fastify";

// Journaux : les jetons d'accès voyagent dans l'URL (liens de document, reçu, paiement, gestion
// d'abonnement, carte) et dans la requête (?token= de l'invitation, ?code= et ?state= du retour OAuth
// Google). Ils sont masqués avant écriture : un journal copié ne donne accès à rien.
const TOKEN_PATH = /^(\/api\/public\/(?:card|documents|manage|pay|receipts|subscribe))\/[^/?#]+/;
const SECRET_QUERY = new Set(["token", "code", "state", "accesscode", "reference", "key", "jti", "jeton"]);
/**
 * Forme d'un jeton de l'ERP, quelle que soit la route (défaut du 27/10/2026 : un lien mal tapé, en 404, ou une clé de
 * requête inconnue gardait son jeton en clair) : aléatoire base64url de 32 caractères et plus (invitation, session,
 * réinitialisation), ou signé en deux parties séparées d'un point. Un identifiant (cuid, 25 caractères) reste lisible.
 */
const TOKEN_SHAPE = /^(?:[A-Za-z0-9_-]{32,}|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})$/;

const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    // mal encodé : comparé tel quel
    return s;
  }
};

export function redactUrl(url: string | undefined): string {
  if (!url) return "";
  const q = url.indexOf("?");
  const path = (q === -1 ? url : url.slice(0, q))
    .replace(TOKEN_PATH, "$1/[jeton]")
    .split("/")
    .map((segment) => (TOKEN_SHAPE.test(decoded(segment)) ? "[jeton]" : segment))
    .join("/");
  if (q === -1) return path;
  const query = url
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? "" : pair.slice(eq + 1);
      return SECRET_QUERY.has(decoded(key).toLowerCase()) || TOKEN_SHAPE.test(decoded(value)) ? `${key}=[masqué]` : pair;
    })
    .join("&");
  return `${path}?${query}`;
}

/** Sérialiseur des requêtes du journal Fastify (mêmes champs que celui par défaut, URL masquée). */
export const logSerializers = {
  req(request: FastifyRequest) {
    return {
      method: request.method,
      url: redactUrl(request.url),
      host: request.headers?.host,
      remoteAddress: request.ip,
      remotePort: request.socket?.remotePort,
    };
  },
};
