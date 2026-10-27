import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAdminOrigins, getAllowedOrigins, isPublicApiPath } from "@/lib/env.js";
import { routePath } from "@/lib/route-path.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Mutations exemptées, et seulement elles (liste testée) :
 * - webhooks : appels de serveur à serveur, authentifiés par signature (Stripe, et plus tard le site) ;
 * - liens de paiement : page servie par l'API elle-même, jeton signé dans l'adresse, aucune session.
 */
export const ORIGIN_GUARD_EXEMPT: readonly RegExp[] = [/^\/api\/webhooks\//, /^\/api\/public\/(pay|subscribe|manage|card)\//];

/** Hôte d'une origine (« https://erp.kouzia.com » donne « erp.kouzia.com ») ; null si illisible ou opaque (« null »). */
function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host || null;
  } catch {
    return null;
  }
}

/**
 * Refuse les mutations venues d'une autre origine (Origin, à défaut Referer, hors liste) : défense en
 * profondeur contre le CSRF, en plus des cookies SameSite=Lax. Même origine que la requête (admin ouverte
 * en LAN ou par Tailscale sur une adresse non listée, page servie par l'API) : acceptée. En production,
 * une mutation sans Origin ni Referer est refusée (un navigateur envoie toujours l'un des deux) ; en dev,
 * tolérée pour curl.
 *
 * fastify-plugin : sans lui, le hook restait encapsulé dans ce plugin et ne s'appliquait à AUCUNE route.
 */
async function originGuard(app: FastifyInstance): Promise<void> {
  // Site public admis seulement sur /api/public/* ; l'admin n'accepte que ses origines (audit du 27/10/2026).
  const allowedPublic = new Set(getAllowedOrigins());
  const allowedAdmin = new Set(getAdminOrigins());
  const isProd = process.env.NODE_ENV === "production";

  const accepted = (request: FastifyRequest, origin: string) => {
    if ((isPublicApiPath(routePath(request)) ? allowedPublic : allowedAdmin).has(origin)) return true;
    const host = hostOf(origin);
    // Hôte brut de la requête (par le tunnel aussi) : même hôte, même origine.
    return Boolean(host && request.headers.host && host === request.headers.host);
  };

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE.has(request.method)) return;
    const path = routePath(request);
    if (ORIGIN_GUARD_EXEMPT.some((re) => re.test(path))) return;

    const origin = request.headers.origin;
    if (origin) {
      if (!accepted(request, origin)) await reply.code(403).send({ error: "Origine non autorisée" });
      return;
    }

    const referer = request.headers.referer;
    if (referer) {
      try {
        if (!accepted(request, new URL(referer).origin)) await reply.code(403).send({ error: "Origine non autorisée" });
      } catch {
        await reply.code(403).send({ error: "Origine non autorisée" });
      }
      return;
    }

    if (isProd) await reply.code(403).send({ error: "Origine de la requête requise" });
  });
}

export const originGuardPlugin = fp(originGuard, { name: "origin-guard" });
