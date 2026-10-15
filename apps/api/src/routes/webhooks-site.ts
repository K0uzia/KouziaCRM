import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { DEPLOY_RESULTS, recordDeployEvent } from "@/lib/site/publish.js";

/**
 * Rappel signé de l'Action de déploiement du site (scripts/deploiement/rappel-erp.sh de KouziaWebsite).
 * Signature : HMAC-SHA256 hexadécimal de « horodatage.corps brut » avec SITE_DEPLOY_WEBHOOK_SECRET
 * (même valeur que ERP_CALLBACK_SECRET côté site). Plugin encapsulé : le corps brut ne vaut que pour
 * cette route. Signature absente ou fausse : même 404 qu'une route inconnue.
 */
const WINDOW_S = 5 * 60;
const body = z.strictObject({
  sha: z.union([z.string().regex(/^[0-9a-f]{40}$/), z.literal("invalide")]),
  resultat: z.enum(DEPLOY_RESULTS),
  run: z.string().max(300),
  livraison: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
});

function validSignature(secret: string, timestamp: string, raw: string, header: string): boolean {
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const webhooksSiteRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1024 }, (_req, raw, done) => done(null, raw));

  app.post(
    "/api/webhooks/site-deploy",
    { bodyLimit: 1024, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const notFound = () => reply.code(404).send({ error: "Not found" });
      const secret = process.env.SITE_DEPLOY_WEBHOOK_SECRET?.trim();
      const raw = typeof request.body === "string" ? request.body : null;
      const timestamp = request.headers["x-kouzia-horodatage"];
      const signature = request.headers["x-kouzia-signature"];
      const delivery = request.headers["x-kouzia-livraison"];
      if (!secret || raw === null || typeof timestamp !== "string" || typeof signature !== "string" || typeof delivery !== "string") {
        return notFound();
      }
      if (!/^\d{1,12}$/.test(timestamp) || !validSignature(secret, timestamp, raw, signature)) return notFound();
      if (Math.abs(Date.now() / 1000 - Number(timestamp)) > WINDOW_S) {
        request.log.warn({ event: "site_deploy_webhook_stale" }, "rappel du site hors fenêtre de 5 minutes");
        return reply.code(400).send({ error: "Horodatage hors fenêtre" });
      }
      let parsed: z.output<typeof body>;
      try {
        const b = body.safeParse(JSON.parse(raw));
        if (!b.success || b.data.livraison !== delivery) return reply.code(400).send({ error: "Corps invalide" });
        parsed = b.data;
      } catch {
        return reply.code(400).send({ error: "Corps invalide" });
      }
      const runUrl = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(parsed.run) ? parsed.run : null;
      const outcome = await recordDeployEvent({ deliveryId: parsed.livraison, sha: parsed.sha, result: parsed.resultat, runUrl });
      if (outcome !== "applied") request.log.info({ event: "site_deploy_webhook", outcome, result: parsed.resultat }, "rappel du site");
      return reply.code(204).send();
    },
  );
};
