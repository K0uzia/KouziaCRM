import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { InvoiceDocumentType, PaymentMethod } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { serializeInvoice } from "@/lib/invoices/serialize.js";
import {
  DocumentFlowError,
  generateBalanceInvoice,
  generateMilestoneInvoice,
  getMarketView,
  computeBalanceSummary,
} from "@/lib/invoices/documentFlowService.js";
import {
  MilestonePaymentError,
  markMilestonePaidManually,
  activateMilestoneCheckout,
} from "@/lib/payments/milestonePaymentService.js";
import {
  acceptQuoteFromThread,
  QuoteDecisionError,
} from "@/lib/invoices/transitions.js";

function actorOf(request: { user?: { id: string; email: string } }) {
  return {
    userId: request.user?.id ?? null,
    userEmail: request.user?.email ?? null,
  };
}

function flowError(reply: import("fastify").FastifyReply, e: unknown) {
  if (e instanceof DocumentFlowError || e instanceof MilestonePaymentError) {
    return reply.code(e.statusCode).send({ error: e.message });
  }
  return reply
    .code(400)
    .send({ error: e instanceof Error ? e.message : "Erreur document" });
}

export const quotesMarketRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>("/api/quotes/:id/market", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      return await getMarketView(request.params.id);
    } catch (e) {
      return flowError(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/quotes/:id/balance-summary",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      try {
        return await computeBalanceSummary(request.params.id);
      } catch (e) {
        return flowError(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string; mid: string } }>(
    "/api/quotes/:id/milestones/:mid/invoice",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const milestone = await prisma.paymentMilestone.findFirst({
        where: { id: request.params.mid, quoteId: request.params.id },
      });
      if (!milestone) return reply.code(404).send({ error: "Jalon introuvable" });
      try {
        const invoice = await generateMilestoneInvoice(milestone.id);
        return reply.code(201).send(serializeInvoice(invoice));
      } catch (e) {
        return flowError(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string; mid: string } }>(
    "/api/quotes/:id/milestones/:mid/pay-manual",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const milestone = await prisma.paymentMilestone.findFirst({
        where: { id: request.params.mid, quoteId: request.params.id },
      });
      if (!milestone) return reply.code(404).send({ error: "Jalon introuvable" });

      const schema = z.object({
        method: z.enum(["BANK_TRANSFER", "CHECK", "CASH", "OTHER"]),
        reference: z.string().max(120).optional().nullable(),
        notes: z.string().max(500).optional().nullable(),
      });
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }
      try {
        const updated = await markMilestonePaidManually({
          milestoneId: milestone.id,
          method: parsed.data.method as PaymentMethod,
          reference: parsed.data.reference,
          notes: parsed.data.notes,
        });
        return updated;
      } catch (e) {
        return flowError(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string; mid: string } }>(
    "/api/quotes/:id/milestones/:mid/checkout",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const milestone = await prisma.paymentMilestone.findFirst({
        where: { id: request.params.mid, quoteId: request.params.id },
      });
      if (!milestone) return reply.code(404).send({ error: "Jalon introuvable" });
      try {
        const updated = await activateMilestoneCheckout(milestone.id, {
          sendEmail: false,
        });
        return {
          checkoutUrl: updated.checkoutUrl,
          revolutOrderId: updated.revolutOrderId,
          status: updated.status,
        };
      } catch (e) {
        return flowError(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/quotes/:id/balance-invoice",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const quote = await prisma.invoice.findUnique({ where: { id: request.params.id } });
      if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE) {
        return reply.code(404).send({ error: "Devis introuvable" });
      }
      const schema = z.object({
        force: z.boolean().optional(),
        issueDate: z.string().optional(),
        milestoneId: z.string().optional(),
      });
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }
      try {
        const result = await generateBalanceInvoice(request.params.id, {
          force: parsed.data.force,
          issueDate: parsed.data.issueDate
            ? new Date(parsed.data.issueDate)
            : undefined,
          milestoneId: parsed.data.milestoneId,
        });
        return reply.code(201).send({
          invoice: serializeInvoice(result.invoice),
          summary: result.summary,
        });
      } catch (e) {
        return flowError(reply, e);
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/quotes/:id/accept-from-thread",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;

      const schema = z.object({
        threadId: z.string().min(1),
        signerName: z.string().min(2).max(120),
      });
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      try {
        const quote = await acceptQuoteFromThread(request.params.id, {
          threadId: parsed.data.threadId,
          signerName: parsed.data.signerName,
          actor: actorOf(request),
        });
        return {
          ok: true,
          quote: serializeInvoice(quote),
        };
      } catch (e) {
        if (e instanceof QuoteDecisionError) {
          return reply.code(400).send({ error: e.message, code: e.code });
        }
        return flowError(reply, e);
      }
    },
  );
};
