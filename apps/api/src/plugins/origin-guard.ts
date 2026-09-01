import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAllowedOrigins } from "@/lib/env.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuse les mutations cross-origin (Origin / Referer hors allowlist).
 * En production, une mutation sans header Origin ni Referer est aussi rejetée
 * (protection CSRF : un navigateur envoie toujours l'un des deux sur POST/PUT/...).
 * En dev, on tolère l'absence pour faciliter les appels curl/Insomnia.
 */
export async function originGuardPlugin(app: FastifyInstance): Promise<void> {
  const allowed = new Set(getAllowedOrigins());
  const isProd = process.env.NODE_ENV === "production";

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE.has(request.method)) return;
    // Webhooks externes (Revolut Merchant, etc.) : pas d'Origin navigateur
    if (request.url.startsWith("/api/webhooks/")) return;

    const origin = request.headers.origin;
    if (origin) {
      if (!allowed.has(origin)) {
        await reply.code(403).send({ error: "Origin non autorisée" });
      }
      return;
    }

    const referer = request.headers.referer;
    if (referer) {
      try {
        if (!allowed.has(new URL(referer).origin)) {
          await reply.code(403).send({ error: "Referer non autorisé" });
        }
      } catch {
        await reply.code(403).send({ error: "Referer invalide" });
      }
      return;
    }

    // Ni Origin ni Referer : en prod, on rejette (CSRF). En dev, on laisse passer.
    if (isProd) {
      await reply.code(403).send({ error: "Header Origin ou Referer requis" });
    }
  });
}
