import type { FastifyInstance } from "fastify";

/**
 * Par le tunnel Cloudflare, deux noms d'hôte pointent vers la même API :
 * - ADMIN_PUBLIC_ORIGIN (erp.kouzia.com) : SPA admin et toute l'API (connexion avec 2FA) ;
 * - tout autre hôte, dont PUBLIC_API_ORIGIN (api.kouzia.com) : seulement les routes publiques.
 * Le LAN et Tailscale (requêtes hors tunnel) ne sont pas concernés.
 */
const PUBLIC_ROUTE_PREFIXES = ["/api/public/", "/api/webhooks/"];
const PUBLIC_ROUTES = new Set(["/api/google/calendar/callback", "/api/health"]);

function hostOf(origin: string | undefined): string | null {
  if (!origin?.trim()) return null;
  try {
    return new URL(origin.trim()).host.toLowerCase();
  } catch {
    throw new Error(`Origine invalide : « ${origin} »`);
  }
}

export function getAdminPublicHost(): string | null {
  return hostOf(process.env.ADMIN_PUBLIC_ORIGIN);
}

/** Route (motif reconnu par le routeur, pas l'URL brute) servie sur l'hôte public. */
export function isPublicRoute(routeUrl: string | undefined): boolean {
  if (!routeUrl) return false;
  return PUBLIC_ROUTES.has(routeUrl) || PUBLIC_ROUTE_PREFIXES.some((p) => routeUrl.startsWith(p));
}

export function registerTunnelHostGuard(app: FastifyInstance): void {
  const adminHost = getAdminPublicHost();
  app.addHook("onRequest", async (request, reply) => {
    if (!request.viaTunnel) return;
    // En-tête Host brut : request.hostname lirait X-Forwarded-Host, fourni par le client.
    const host = request.headers.host?.toLowerCase() ?? "";
    if (adminHost && host === adminHost) return;
    if (isPublicRoute(request.routeOptions.url)) return;
    // Même réponse qu'une route /api inexistante (app.ts, setNotFoundHandler). Pas de callNotFound :
    // hors /api, il servirait index.html, donc la SPA admin.
    return reply.code(404).send({ error: "Not found" });
  });
}
