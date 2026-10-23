import type { FastifyRequest } from "fastify";

// Journaux : les jetons d'accès voyagent dans l'URL (liens de document, reçu, paiement, gestion
// d'abonnement, carte) et dans la requête (?token= de l'invitation, ?code= et ?state= du retour OAuth
// Google). Ils sont masqués avant écriture : un journal copié ne donne accès à rien.
const TOKEN_PATH = /^(\/api\/public\/(?:card|documents|manage|pay|receipts|subscribe))\/[^/?#]+/;
const SECRET_QUERY = new Set(["token", "code", "state", "accesscode", "reference", "key", "jti", "jeton"]);

export function redactUrl(url: string | undefined): string {
  if (!url) return "";
  const q = url.indexOf("?");
  const path = (q === -1 ? url : url.slice(0, q)).replace(TOKEN_PATH, "$1/[jeton]");
  if (q === -1) return path;
  const query = url
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const key = pair.split("=")[0] ?? "";
      let name = key;
      try {
        name = decodeURIComponent(key);
      } catch {
        // clé mal encodée : comparée telle quelle
      }
      return SECRET_QUERY.has(name.toLowerCase()) ? `${key}=[masqué]` : pair;
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
