import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@/lib/prisma.js";
import {
  extractMilestoneReference,
  extractRevolutEventId,
  extractRevolutEventType,
  extractRevolutOrderId,
  getRevolutMerchantConfig,
  verifyRevolutWebhookSignature,
} from "@/lib/revolut/merchantService.js";
import {
  markMilestoneFailedFromRevolut,
  markMilestonePaidFromRevolut,
  notifyDepositFailed,
  notifyDepositPaid,
} from "@/lib/payments/milestonePaymentService.js";

const SUCCESS_EVENTS = new Set([
  "ORDER_COMPLETED",
  "ORDER_AUTHORISED",
  "order.completed",
  "order.authorised",
]);

const FAILURE_EVENTS = new Set([
  "ORDER_PAYMENT_FAILED",
  "ORDER_PAYMENT_DECLINED",
  "ORDER_FAILED",
  "order.payment_failed",
  "order.payment_declined",
  "order.failed",
]);

export const webhooksRevolutRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post("/api/webhooks/revolut", async (request, reply) => {
    const rawBody =
      typeof request.body === "string"
        ? request.body
        : JSON.stringify(request.body ?? {});

    let config;
    try {
      config = await getRevolutMerchantConfig();
    } catch {
      return reply.code(503).send({ error: "Revolut non configuré" });
    }

    if (!config.webhookSecret) {
      return reply.code(503).send({ error: "Secret webhook Revolut absent" });
    }

    const valid = verifyRevolutWebhookSignature({
      rawBody,
      timestamp: request.headers["revolut-request-timestamp"] as string | undefined,
      signatureHeader: request.headers["revolut-signature"] as string | undefined,
      signingSecret: config.webhookSecret,
    });

    if (!valid) {
      request.log.warn({ event: "revolut_webhook_invalid_signature" });
      return reply.code(401).send({ error: "Signature invalide" });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: "JSON invalide" });
    }

    const eventType = extractRevolutEventType(payload);
    const eventId = extractRevolutEventId(payload);
    let milestoneId = extractMilestoneReference(payload);
    const orderId = extractRevolutOrderId(payload);

    if (!milestoneId && orderId) {
      const byOrder = await prisma.paymentMilestone.findFirst({
        where: { revolutOrderId: orderId },
      });
      milestoneId = byOrder?.id ?? null;
    }

    if (!milestoneId) {
      request.log.warn({ event: "revolut_webhook_orphan", eventType, orderId });
      return { ok: true, ignored: true };
    }

    const normalized = eventType.toUpperCase().replace(/\./g, "_");

    if (SUCCESS_EVENTS.has(eventType) || SUCCESS_EVENTS.has(normalized)) {
      const result = await markMilestonePaidFromRevolut({
        milestoneId,
        revolutOrderId: orderId ?? "",
        revolutPaymentId:
          typeof payload.payment_id === "string" ? payload.payment_id : null,
        eventId,
        eventType,
        payload,
      });
      if (!result.duplicate && result.milestone) {
        await notifyDepositPaid(milestoneId);
      }
      return { ok: true, duplicate: result.duplicate };
    }

    if (FAILURE_EVENTS.has(eventType) || FAILURE_EVENTS.has(normalized)) {
      const result = await markMilestoneFailedFromRevolut({
        milestoneId,
        revolutOrderId: orderId ?? "",
        eventId,
        eventType,
        payload,
      });
      if (!result.duplicate) {
        await notifyDepositFailed(milestoneId, eventType);
      }
      return { ok: true, duplicate: result.duplicate };
    }

    request.log.info({ event: "revolut_webhook_unhandled", eventType });
    return { ok: true, ignored: true };
  });
};
