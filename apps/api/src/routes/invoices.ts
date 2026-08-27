import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  PaymentMethod,
  QuoteStatus,
} from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { computeLineTotals } from "@/lib/invoices/totals.js";
import { eurosToCents } from "@/lib/money.js";
import {
  issueInvoice,
  issueQuote,
  convertQuoteToInvoice,
  cancelInvoiceWithCreditNote,
  assessCreditNoteEligibility,
  createCreditNote,
  CreditNoteError,
  DocumentFlowError,
  assertQuoteEditable,
  syncMilestoneOnInvoicePaid,
} from "@/lib/invoices/transitions.js";
import { CreditNoteReason, RefundMethod } from "@prisma/client";
import { getCompanySettings } from "@/lib/company.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import { decryptOptional } from "@/lib/crypto.js";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";
import { serializeInvoice } from "@/lib/invoices/serialize.js";
import { serializeClient } from "@/lib/clients.js";
import { ensureQuoteMilestones } from "@/lib/quotes/milestones.js";
import {
  listPendingReminders,
  markReminderSent,
} from "@/lib/reminders.js";
import { isSmtpConfigured, sendEmail } from "@/lib/email/smtp.js";
import { signDocumentToken } from "@/lib/documents/public-token.js";
import { listActiveLegalClauses } from "@/lib/company/legal-clauses.js";

const lineSchema = z.object({
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unitPriceEuros: z.coerce.number(),
});

const createSchema = z.object({
  clientId: z.string().min(1),
  documentType: z.enum(["INVOICE", "QUOTE"]).default("INVOICE"),
  notes: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  validUntil: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1),
});

const updateSchema = z.object({
  clientId: z.string().min(1).optional(),
  notes: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  validUntil: z.string().optional().nullable(),
  lines: z.array(lineSchema).min(1).optional(),
});

const paySchema = z.object({
  amountEuros: z.coerce.number().positive(),
  paidAt: z.string().optional(),
  method: z.nativeEnum(PaymentMethod).optional(),
  reference: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

function defaultQuoteValidUntil(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d;
}

export const invoicesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/invoices", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { type?: string; market?: string };
    const where: Record<string, unknown> =
      q.type === "QUOTE"
        ? { documentType: InvoiceDocumentType.QUOTE }
        : q.type === "ALL"
          ? {}
          : {
              documentType: {
                in: [InvoiceDocumentType.INVOICE, InvoiceDocumentType.CREDIT_NOTE],
              },
            };
    if (q.market) {
      where.quoteId = q.market;
    }

    const rows = await prisma.invoice.findMany({
      where,
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
      include: {
        client: { select: { id: true, displayName: true, clientNumber: true } },
        payments: true,
        quote: { select: { id: true, number: true } },
      },
    });
    return rows.map(serializeInvoice);
  });

  app.post("/api/invoices", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const parsed = createSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
      }
      const client = await prisma.client.findUnique({ where: { id: parsed.data.clientId } });
      if (!client) return reply.code(404).send({ error: "Client introuvable" });

      const { lines, subtotalCents, totalCents } = computeLineTotals(
        parsed.data.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: eurosToCents(l.unitPriceEuros),
        })),
      );

      const documentType =
        parsed.data.documentType === "QUOTE"
          ? InvoiceDocumentType.QUOTE
          : InvoiceDocumentType.INVOICE;

      const validUntil =
        documentType === InvoiceDocumentType.QUOTE
          ? parsed.data.validUntil
            ? new Date(parsed.data.validUntil)
            : defaultQuoteValidUntil()
          : parsed.data.validUntil
            ? new Date(parsed.data.validUntil)
            : null;

      const invoice = await prisma.invoice.create({
        data: {
          documentType,
          quoteStatus: documentType === InvoiceDocumentType.QUOTE ? QuoteStatus.DRAFT : null,
          clientId: parsed.data.clientId,
          notes: parsed.data.notes ?? null,
          paymentTerms:
            parsed.data.paymentTerms ??
            (documentType === InvoiceDocumentType.QUOTE
              ? "Devis valable 30 jours"
              : "Paiement à réception"),
          validUntil,
          subtotalCents,
          totalCents,
          lines: { create: lines },
        },
        include: {
          lines: true,
          client: { select: { id: true, displayName: true, clientNumber: true } },
        },
      });
      return reply.code(201).send(serializeInvoice(invoice));
    } catch (e) {
      request.log.error({ err: e }, "POST /api/invoices");
      throw e;
    }
  });

  app.get("/api/invoices/search", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = String((request.query as { q?: string }).q ?? "").trim();
    if (q.length < 1) return [];

    const invoices = await prisma.invoice.findMany({
      where: {
        documentType: "INVOICE",
        payments: { some: {} },
        OR: [
          { number: { contains: q } },
          { client: { displayName: { contains: q } } },
        ],
      },
      include: {
        payments: { select: { amountCents: true } },
        client: { select: { displayName: true } },
      },
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }],
      take: 12,
    });

    return invoices.map((inv) => ({
      id: inv.id,
      number: inv.number,
      displayName: inv.client.displayName,
      paidCents: inv.payments.reduce((s, p) => s + p.amountCents, 0),
    }));
  });

  app.get("/api/reminders/pending", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const rows = await listPendingReminders();
    return rows.map(serializeInvoice);
  });

  app.get<{ Params: { id: string } }>("/api/invoices/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const invoice = await prisma.invoice.findUnique({
      where: { id: request.params.id },
      include: {
        lines: { orderBy: { position: "asc" } },
        client: true,
        payments: { orderBy: { paidAt: "desc" } },
        creditedInvoice: true,
        creditNotes: true,
        quote: { select: { id: true, number: true, issueDate: true } },
        milestones: { orderBy: { position: "asc" } },
      },
    });
    if (!invoice) return reply.code(404).send({ error: "Introuvable" });
    return {
      ...serializeInvoice(invoice),
      client: serializeClient(invoice.client),
    };
  });

  app.put<{ Params: { id: string } }>("/api/invoices/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const id = request.params.id;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (
      "number" in body ||
      "documentNumber" in body ||
      "sequenceYear" in body ||
      "sequenceNumber" in body
    ) {
      return reply.code(403).send({
        error: "Le numéro de document est immuable après attribution",
      });
    }
    const existing = await prisma.invoice.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Introuvable" });
    if (existing.status !== InvoiceStatus.DRAFT) {
      return reply.code(400).send({ error: "Seuls les brouillons sont modifiables" });
    }
    if (existing.documentType === InvoiceDocumentType.QUOTE) {
      try {
        await assertQuoteEditable(existing.id);
      } catch (e) {
        if (e instanceof DocumentFlowError) {
          return reply.code(e.statusCode).send({ error: e.message });
        }
        throw e;
      }
    }

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    }

    const data: {
      clientId?: string;
      notes?: string | null;
      paymentTerms?: string | null;
      subtotalCents?: number;
      totalCents?: number;
      validUntil?: Date | null;
    } = {};

    if (parsed.data.clientId) data.clientId = parsed.data.clientId;
    if (parsed.data.notes !== undefined) data.notes = parsed.data.notes;
    if (parsed.data.paymentTerms !== undefined) data.paymentTerms = parsed.data.paymentTerms;
    if (parsed.data.validUntil !== undefined) {
      data.validUntil = parsed.data.validUntil ? new Date(parsed.data.validUntil) : null;
    }

    if (parsed.data.lines) {
      const computed = computeLineTotals(
        parsed.data.lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: eurosToCents(l.unitPriceEuros),
        })),
      );
      data.subtotalCents = computed.subtotalCents;
      data.totalCents = computed.totalCents;

      await prisma.$transaction([
        prisma.invoiceLine.deleteMany({ where: { invoiceId: id } }),
        prisma.invoice.update({
          where: { id },
          data: { ...data, lines: { create: computed.lines } },
        }),
      ]);
    } else {
      await prisma.invoice.update({ where: { id }, data });
    }

    const updated = await prisma.invoice.findUniqueOrThrow({
      where: { id },
      include: {
        lines: true,
        client: { select: { id: true, displayName: true, clientNumber: true } },
      },
    });
    return serializeInvoice(updated);
  });

  app.delete("/api/invoices/:id", async (_request, reply) => {
    return reply.code(405).send({ error: "Suppression interdite - annulez via un avoir" });
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/issue", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const body = (request.body ?? {}) as {
      issueDate?: string;
      dueDate?: string;
      validUntil?: string;
    };
    let issueDate = new Date();
    let dueDate: Date | undefined;
    let validUntil: Date | undefined;
    if (body.issueDate) issueDate = new Date(body.issueDate);
    if (body.dueDate) dueDate = new Date(body.dueDate);
    if (body.validUntil) validUntil = new Date(body.validUntil);
    try {
      const doc = await prisma.invoice.findUnique({ where: { id: request.params.id } });
      if (!doc) return reply.code(404).send({ error: "Introuvable" });
      if (doc.documentType === InvoiceDocumentType.QUOTE) {
        const q = await issueQuote(request.params.id, issueDate, validUntil ?? dueDate);
        return serializeInvoice(q);
      }
      const inv = await issueInvoice(request.params.id, issueDate, dueDate);
      return serializeInvoice(inv);
    } catch (e) {
      request.log.error({ err: e }, "[issue]");
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Erreur d'émission" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/invoices/:id/convert", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const invoice = await convertQuoteToInvoice(request.params.id);
      return reply.code(201).send(serializeInvoice(invoice));
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Conversion impossible" });
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/invoices/:id/milestones",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const quote = await prisma.invoice.findUnique({ where: { id: request.params.id } });
      if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE) {
        return reply.code(404).send({ error: "Devis introuvable" });
      }
      if (quote.status === InvoiceStatus.DRAFT && quote.quoteStatus === QuoteStatus.DRAFT) {
        return prisma.paymentMilestone.findMany({
          where: { quoteId: quote.id },
          orderBy: { position: "asc" },
        });
      }
      const milestones = await ensureQuoteMilestones(quote.id, quote.totalCents);
      return milestones;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/invoices/:id/reminders/send",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const invoice = await prisma.invoice.findUnique({
        where: { id: request.params.id },
        include: { client: true },
      });
      if (!invoice) return reply.code(404).send({ error: "Introuvable" });

      const email = decryptOptional(invoice.client.emailEncrypted);
      const label = invoice.documentType === InvoiceDocumentType.QUOTE ? "devis" : "facture";
      const subject = `Relance - ${label} ${invoice.number ?? "brouillon"}`;
      const body = `Bonjour,\n\nSauf erreur de notre part, le ${label} ${invoice.number ?? ""} est en attente.\n\nCordialement,\nKouzia`;

      if (email && isSmtpConfigured()) {
        await sendEmail({ to: email, subject, text: body });
      }

      const updated = await markReminderSent(invoice.id);
      return {
        ...serializeInvoice(updated),
        emailed: Boolean(email && isSmtpConfigured()),
        mailto: email
          ? `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
          : null,
      };
    },
  );

  app.post<{ Params: { id: string } }>("/api/invoices/:id/pay", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const id = request.params.id;
    const parsed = paySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { payments: true },
    });
    if (!invoice) return reply.code(404).send({ error: "Introuvable" });
    if (invoice.status !== InvoiceStatus.ISSUED && invoice.status !== InvoiceStatus.PAID) {
      return reply.code(400).send({ error: "Paiement possible uniquement sur facture émise" });
    }
    if (invoice.totalCents < 0) {
      return reply.code(400).send({ error: "Pas de paiement sur un avoir" });
    }

    const amountCents = eurosToCents(parsed.data.amountEuros);
    const paidSoFar = invoice.payments.reduce((s, p) => s + p.amountCents, 0);

    const payment = await prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          invoiceId: id,
          amountCents,
          paidAt: parsed.data.paidAt ? new Date(parsed.data.paidAt) : new Date(),
          method: parsed.data.method ?? PaymentMethod.BANK_TRANSFER,
          reference: parsed.data.reference ?? null,
          notes: parsed.data.notes ?? null,
        },
      });
      if (paidSoFar + amountCents >= invoice.totalCents) {
        await tx.invoice.update({ where: { id }, data: { status: InvoiceStatus.PAID } });
        await syncMilestoneOnInvoicePaid(id, tx);
      }
      return created;
    });

    return reply.code(201).send(payment);
  });

  app.get<{ Params: { id: string } }>(
    "/api/invoices/:id/credit-note/eligibility",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      try {
        return await assessCreditNoteEligibility(request.params.id);
      } catch (e) {
        if (e instanceof CreditNoteError) {
          return reply.code(e.code === "NOT_FOUND" ? 404 : 400).send({
            error: e.message,
            code: e.code,
          });
        }
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/invoices/:id/credit-note",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const schema = z.object({
        amountEuros: z.coerce.number().positive(),
        reason: z.nativeEnum(CreditNoteReason),
        reasonDetail: z.string().optional().nullable(),
        refundMethod: z.nativeEnum(RefundMethod),
        cgvDepositRefundable: z.boolean().optional().nullable(),
        issueDate: z.string().optional(),
        registerRefundPayment: z.boolean().optional(),
        refundPaidAt: z.string().optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }
      try {
        const creditNote = await createCreditNote(request.params.id, {
          amountCents: eurosToCents(parsed.data.amountEuros),
          reason: parsed.data.reason,
          reasonDetail: parsed.data.reasonDetail,
          refundMethod: parsed.data.refundMethod,
          cgvDepositRefundable: parsed.data.cgvDepositRefundable,
          issueDate: parsed.data.issueDate
            ? new Date(parsed.data.issueDate)
            : new Date(),
          registerRefundPayment: parsed.data.registerRefundPayment,
          refundPaidAt: parsed.data.refundPaidAt
            ? new Date(parsed.data.refundPaidAt)
            : undefined,
        });
        return reply.code(201).send(serializeInvoice(creditNote));
      } catch (e) {
        if (e instanceof CreditNoteError) {
          return reply.code(400).send({ error: e.message, code: e.code });
        }
        return reply
          .code(400)
          .send({ error: e instanceof Error ? e.message : "Erreur avoir" });
      }
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/invoices/:id/credit-note/follow-up",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const schema = z.object({
        sentToClient: z.boolean().optional(),
        bankTransferDone: z.boolean().optional(),
        receiptsLineAdded: z.boolean().optional(),
        archivedWithOriginal: z.boolean().optional(),
        urssafImpactNoted: z.boolean().optional(),
        negativeCarryoverReminder: z.boolean().optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Données invalides" });
      }
      const inv = await prisma.invoice.findUnique({
        where: { id: request.params.id },
      });
      if (!inv || inv.documentType !== InvoiceDocumentType.CREDIT_NOTE) {
        return reply.code(404).send({ error: "Avoir introuvable" });
      }
      const prev =
        (inv.creditFollowUp as Record<string, boolean> | null) ?? {};
      const updated = await prisma.invoice.update({
        where: { id: inv.id },
        data: {
          creditFollowUp: { ...prev, ...parsed.data },
        },
      });
      return { creditFollowUp: updated.creditFollowUp };
    },
  );

  app.post<{ Params: { id: string } }>("/api/invoices/:id/cancel", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const body = (request.body ?? {}) as { issueDate?: string };
    const issueDate = body.issueDate ? new Date(body.issueDate) : new Date();
    try {
      const creditNote = await cancelInvoiceWithCreditNote(request.params.id, issueDate);
      return reply.code(201).send(serializeInvoice(creditNote));
    } catch (e) {
      if (e instanceof CreditNoteError) {
        return reply.code(400).send({
          error: e.message,
          code: e.code,
          ...(e.code === "UNPAID"
            ? {
                alternative:
                  "Conservez la facture, émettez une facture corrigée si besoin. Ne déclarez que les encaissements réels.",
              }
            : {}),
        });
      }
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Erreur d'annulation" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/invoices/:id/pdf", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const invoice = await prisma.invoice.findUnique({
      where: { id: request.params.id },
      include: {
        lines: { orderBy: { position: "asc" } },
        client: true,
        creditedInvoice: true,
        quote: true,
        sourceMilestone: true,
        milestones: { orderBy: { position: "asc" } },
      },
    });
    if (!invoice) return reply.code(404).send({ error: "Introuvable" });
    if (invoice.status === InvoiceStatus.DRAFT || !invoice.number) {
      return reply.code(400).send({ error: "PDF disponible uniquement après émission" });
    }

    const company = await getCompanySettings();
    const legalClauses = await listActiveLegalClauses();
    const snapshot =
      (invoice.clientSnapshot as ClientSnapshot | null) ??
      ({
        displayName: invoice.client.displayName,
        type: invoice.client.type,
        email: decryptOptional(invoice.client.emailEncrypted),
        phone: decryptOptional(invoice.client.phoneEncrypted),
        siret: decryptOptional(invoice.client.siretEncrypted),
        addressLine1: invoice.client.addressLine1,
        addressLine2: invoice.client.addressLine2,
        postalCode: invoice.client.postalCode,
        city: invoice.client.city,
        country: invoice.client.country,
      } satisfies ClientSnapshot);

    let balanceSummary = null;
    if (invoice.invoiceType === "SOLDE" && invoice.quoteId) {
      const { computeBalanceSummary } = await import(
        "@/lib/invoices/documentFlowService.js"
      );
      const s = await computeBalanceSummary(invoice.quoteId);
      balanceSummary = {
        marketTotalCents: s.marketTotalCents,
        quoteNumber: s.quoteNumber,
        acomptes: s.acomptes.map((a) => ({
          number: a.number,
          amountCents: a.amountCents,
          paid: a.paid,
          label: a.label,
          deductedCents: a.deductedCents,
        })),
        balanceDueCents: invoice.totalCents,
      };
    }

    const buffer = await renderInvoicePdf({
      company,
      invoice: buildInvoicePdfPayload({ invoice, legalClauses, balanceSummary }),
      client: snapshot,
    });

    return reply
      .header("Content-Type", "application/pdf")
      .header("Content-Disposition", `attachment; filename="${invoice.number}.pdf"`)
      .send(buffer);
  });

  app.get<{ Params: { id: string } }>(
    "/api/invoices/:id/public-token",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const inv = await prisma.invoice.findUnique({ where: { id: request.params.id } });
      if (!inv || !inv.number) return reply.code(404).send({ error: "Introuvable" });
      return { token: signDocumentToken(inv.id) };
    },
  );
};
