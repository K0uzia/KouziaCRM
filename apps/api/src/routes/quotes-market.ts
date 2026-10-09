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
  setManualMilestonePaymentLink,
} from "@/lib/payments/milestonePaymentService.js";
import {
  acceptQuoteByClient,
  acceptQuoteFromThread,
  QuoteDecisionError,
} from "@/lib/invoices/transitions.js";
import { signedQuoteAbsolutePath } from "@/lib/invoices/acceptance-proof.js";
import { WorkflowError } from "@/lib/invoices/workflow.js";
import { applyPaymentLinkChoice } from "@/lib/invoices/payment-link.js";
import { sendDocumentPdf } from "@/lib/email/send-document-pdf.js";
import fs from "node:fs/promises";

function actorOf(request: { user?: { id: string; email: string } }) {
  return {
    userId: request.user?.id ?? null,
    userEmail: request.user?.email ?? null,
  };
}

function flowError(reply: import("fastify").FastifyReply, e: unknown) {
  if (e instanceof DocumentFlowError || e instanceof MilestonePaymentError || e instanceof WorkflowError) {
    return reply.code(e.statusCode).send({ error: e.message });
  }
  return reply
    .code(400)
    .send({ error: e instanceof Error ? e.message : "Erreur document" });
}

/** Options de la fenêtre « Facturer » : lien de paiement puis envoi au client. */
export const billingOptionsSchema = z.object({
  payment: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("none") }),
      z.object({ mode: z.literal("manual"), url: z.string().min(1).max(2000) }),
      z.object({ mode: z.literal("auto") }),
    ])
    .optional(),
  email: z
    .object({
      send: z.boolean(),
      subject: z.string().max(300).optional(),
      body: z.string().max(20000).optional(),
    })
    .optional(),
});

type BillingOptions = z.infer<typeof billingOptionsSchema>;

/**
 * Après création de la facture : lien de paiement puis email. La facture existe déjà :
 * un échec ici est signalé sans l'annuler (on corrige depuis la fiche facture).
 */
export async function finalizeBilling(invoiceId: string, opts: BillingOptions) {
  let paymentUrl: string | null = null;
  let warning: string | null = null;
  try {
    paymentUrl = await applyPaymentLinkChoice(invoiceId, opts.payment);
  } catch (e) {
    warning = e instanceof Error ? e.message : "Lien de paiement non enregistré";
  }
  let emailed = false;
  let emailReason: string | null = null;
  if (opts.email?.send) {
    const mail = await sendDocumentPdf(invoiceId, {
      subject: opts.email.subject,
      text: opts.email.body,
    });
    emailed = mail.sent;
    emailReason = mail.reason ?? null;
  }
  return { paymentUrl, emailed, emailReason, warning };
}

export const quotesMarketRoutes: FastifyPluginAsync = async (app) => {
  // Signature recueillie hors de l'espace client (papier, email signé) : tracée comme acceptation ADMIN.
  app.post<{ Params: { id: string } }>("/api/quotes/:id/sign-offline", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = z
      .object({ signerName: z.string().trim().min(2, "Nom du signataire requis").max(120) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Données invalides" });
    }
    try {
      const quote = await acceptQuoteByClient(request.params.id, parsed.data.signerName, {
        source: "ADMIN",
        actor: actorOf(request as { user?: { id: string; email: string } }),
      });
      return { quoteStatus: quote.quoteStatus };
    } catch (e) {
      if (e instanceof QuoteDecisionError) return reply.code(409).send({ error: e.message, code: e.code });
      throw e;
    }
  });

  // Preuves de signature d'un devis (plus récente en premier).
  app.get<{ Params: { id: string } }>("/api/quotes/:id/acceptances", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return prisma.quoteAcceptanceAudit.findMany({
      where: { quoteId: request.params.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        signerName: true,
        source: true,
        userEmail: true,
        ipAddress: true,
        userAgent: true,
        pdfSha256: true,
        pdfPath: true,
        createdAt: true,
      },
    });
  });

  app.get<{ Params: { id: string; auditId: string } }>(
    "/api/quotes/:id/acceptances/:auditId/pdf",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const audit = await prisma.quoteAcceptanceAudit.findFirst({
        where: { id: request.params.auditId, quoteId: request.params.id },
        select: { pdfPath: true },
      });
      if (!audit?.pdfPath) return reply.code(404).send({ error: "PDF signé introuvable" });
      try {
        const pdf = await fs.readFile(signedQuoteAbsolutePath(audit.pdfPath));
        return reply
          .header("Content-Type", "application/pdf")
          .header("Content-Disposition", `inline; filename="${audit.pdfPath.split("/").pop()}"`)
          .send(pdf);
      } catch {
        return reply.code(404).send({ error: "PDF signé introuvable" });
      }
    },
  );

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
      const opts = billingOptionsSchema.safeParse(request.body ?? {});
      if (!opts.success) return reply.code(400).send({ error: "Options de facturation invalides" });
      try {
        const invoice = await generateMilestoneInvoice(milestone.id);
        const billing = await finalizeBilling(invoice.id, opts.data);
        return reply.code(201).send({ ...serializeInvoice(invoice), ...billing });
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
        notifyClient: z.boolean().optional(),
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
          notifyClient: parsed.data.notifyClient,
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

  app.post<{ Params: { id: string; mid: string } }>(
    "/api/quotes/:id/milestones/:mid/payment-link",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const milestone = await prisma.paymentMilestone.findFirst({
        where: { id: request.params.mid, quoteId: request.params.id },
      });
      if (!milestone) return reply.code(404).send({ error: "Jalon introuvable" });

      const schema = z.object({
        checkoutUrl: z.string().url().max(2000),
        sendEmail: z.boolean().optional(),
      });
      const parsed = schema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "URL de paiement invalide" });
      }
      try {
        const updated = await setManualMilestonePaymentLink(
          milestone.id,
          parsed.data.checkoutUrl,
          { sendEmail: parsed.data.sendEmail !== false },
        );
        return {
          checkoutUrl: updated.checkoutUrl,
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
      const schema = billingOptionsSchema.extend({
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
        const billing = await finalizeBilling(result.invoice.id, parsed.data);
        return reply.code(201).send({
          invoice: serializeInvoice(result.invoice),
          summary: result.summary,
          ...billing,
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
