import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { InvoiceDocumentType } from "@prisma/client";
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

function flowError(reply: import("fastify").FastifyReply, e: unknown) {
  if (e instanceof DocumentFlowError) {
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
};
