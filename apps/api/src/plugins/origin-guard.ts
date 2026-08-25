import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getAllowedOrigins } from "@/lib/env.js";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuse les mutations cross-origin (Origin / Referer hors allowlist).
 */
export async function originGuardPlugin(app: FastifyInstance): Promise<void> {
  const allowed = new Set(getAllowedOrigins());

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (SAFE.has(request.method)) return;

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
    }
  });
}
