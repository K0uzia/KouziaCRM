import type { FastifyPluginAsync } from "fastify";
import type Stripe from "stripe";
import { getStripeConfig } from "@/lib/stripe/client.js";
import { processStripeEvent } from "@/lib/stripe/webhook-handlers.js";
import StripeSdk from "stripe";

export const webhooksStripeRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post(
    "/api/webhooks/stripe",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request, reply) => {
    const rawBody =
      typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body ?? {});

    let config;
    try {
      config = await getStripeConfig();
    } catch {
      return reply.code(503).send({ error: "Stripe non configuré" });
    }

    if (!config.webhookSecret) {
      return reply.code(503).send({ error: "Secret webhook Stripe absent" });
    }

    const signature = request.headers["stripe-signature"];
    if (typeof signature !== "string") {
      return reply.code(400).send({ error: "Signature absente" });
    }

    let event: Stripe.Event;
    try {
      event = StripeSdk.webhooks.constructEvent(
        rawBody,
        signature,
        config.webhookSecret,
      );
    } catch (err) {
      request.log.warn({
        event: "stripe_webhook_invalid_signature",
        err: err instanceof Error ? err.message : String(err),
      });
      return reply.code(401).send({ error: "Signature invalide" });
    }

    try {
      const result = await processStripeEvent(event);
      return { ok: true, ...result };
    } catch (err) {
      request.log.error({ err, eventId: event.id, type: event.type }, "stripe_webhook_error");
      return reply.code(500).send({ error: "Traitement échoué" });
    }
    },
  );
};
