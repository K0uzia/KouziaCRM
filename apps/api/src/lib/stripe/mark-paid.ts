import { BALANCE_INCLUDE, invoiceBalance } from "@/lib/invoices/balance.js";
import { applySettledStatus } from "@/lib/invoices/balance-status.js";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  MilestoneStatus,
  PaymentMethod,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import {
  generateMilestoneInvoice,
  syncMilestoneOnInvoicePaid,
} from "@/lib/invoices/documentFlowService.js";
import {
  notifyDepositFailed,
  notifyDepositPaid,
} from "@/lib/payments/milestonePaymentService.js";

export class StripePaymentError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export type OnlinePaymentInput = {
  amountCents: number;
  method: PaymentMethod;
  paymentIntentId: string;
  feeCents?: number | null;
  notes?: string | null;
  /** Jalon d'acompte (sinon facture simple). */
  milestoneId?: string | null;
  invoiceId?: string | null;
};

/**
 * Enregistre un paiement en ligne (Stripe) : facture PAID, Payment, sync jalon,
 * reçu et démarrage projet. Idempotent sur stripePaymentIntentId.
 */
export async function markPaidFromOnlinePayment(
  input: OnlinePaymentInput,
): Promise<{ duplicate: boolean; invoiceId: string | null; milestoneId: string | null }> {
  const existing = await prisma.payment.findUnique({
    where: { stripePaymentIntentId: input.paymentIntentId },
  });
  if (existing) {
    return {
      duplicate: true,
      invoiceId: existing.invoiceId,
      milestoneId: input.milestoneId ?? null,
    };
  }

  let milestoneId = input.milestoneId?.trim() || null;
  let invoiceId = input.invoiceId?.trim() || null;

  if (milestoneId) {
    const milestoneBefore = await prisma.paymentMilestone.findUnique({
      where: { id: milestoneId },
    });
    if (!milestoneBefore) {
      throw new StripePaymentError("Jalon introuvable", 404);
    }
    if (!milestoneBefore.invoiceId && milestoneBefore.status !== MilestoneStatus.PAID) {
      await generateMilestoneInvoice(milestoneBefore.id);
    }
  }

  let overpaidCents = 0;
  const result = await prisma.$transaction(async (tx) => {
    const again = await tx.payment.findUnique({
      where: { stripePaymentIntentId: input.paymentIntentId },
    });
    if (again) {
      return {
        duplicate: true as const,
        invoiceId: again.invoiceId,
        milestoneId,
      };
    }

    let milestone = milestoneId
      ? await tx.paymentMilestone.findUnique({ where: { id: milestoneId } })
      : null;

    if (milestone?.invoiceId) {
      invoiceId = milestone.invoiceId;
    }

    if (!invoiceId) {
      throw new StripePaymentError("Facture introuvable pour ce paiement", 404);
    }

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { ...BALANCE_INCLUDE, payments: true },
    });
    if (invoice.documentType !== InvoiceDocumentType.INVOICE) {
      throw new StripePaymentError("Document invalide", 400);
    }

    // Montant réellement reçu, toujours enregistré (livre des recettes, URSSAF) : jamais plafonné au reste dû. Un
    // virement Stripe peut arriver après un avoir émis entre-temps : le trop-perçu est signalé, à rembourser.
    const before = invoiceBalance(invoice);
    if (input.amountCents > 0 && !invoice.payments.some((p) => p.stripePaymentIntentId === input.paymentIntentId)) {
      await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          amountCents: input.amountCents,
          paidAt: new Date(),
          method: input.method,
          reference: input.paymentIntentId,
          notes: input.notes?.trim() || (before.dueCents > 0 ? "Paiement Stripe" : "Paiement Stripe (facture déjà soldée)"),
          stripePaymentIntentId: input.paymentIntentId,
          feeCents: input.feeCents ?? null,
        },
      });
      if (input.amountCents > before.dueCents) overpaidCents = input.amountCents - before.dueCents;
      await applySettledStatus(tx, invoice.id);
    }

    if (milestone && milestone.status !== MilestoneStatus.PAID) {
      milestone = await tx.paymentMilestone.update({
        where: { id: milestone.id },
        data: {
          status: MilestoneStatus.PAID,
          paidAt: new Date(),
          paymentMethod: input.method,
          checkoutUrl: null,
        },
      });
      milestoneId = milestone.id;
    }

    return { duplicate: false as const, invoiceId: invoice.id, milestoneId };
  });

  if (!result.duplicate && overpaidCents > 0 && result.invoiceId) {
    // Trop-perçu (avoir émis pendant que le virement Stripe était en route) : à rembourser par un avoir.
    const { alertAdmin } = await import("@/lib/stripe/alert.js");
    const inv = await prisma.invoice.findUnique({ where: { id: result.invoiceId }, select: { number: true } });
    await alertAdmin(
      `Trop-perçu sur la facture ${inv?.number ?? ""}`,
      `Paiement Stripe de ${(input.amountCents / 100).toFixed(2)} € reçu, dont ${(overpaidCents / 100).toFixed(2)} € au-delà du reste dû (avoir émis entre-temps). Le paiement est enregistré en entier ; remboursez le trop-perçu depuis la fiche de la facture (« Enregistrer un remboursement »).`,
    ).catch(() => undefined);
  }

  if (!result.duplicate) {
    if (result.milestoneId) {
      await notifyDepositPaid(result.milestoneId, { online: true, notifyClient: true });
      const milestone = await prisma.paymentMilestone.findUnique({
        where: { id: result.milestoneId },
      });
      if (milestone) {
        const { startProjectForQuote } = await import("@/lib/projects/lifecycle.js");
        await startProjectForQuote(milestone.quoteId);
      }
    } else if (result.invoiceId) {
      const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
      await sendPaymentReceipt(result.invoiceId, input.amountCents);
    }
  }

  return result;
}

export async function markMilestoneFailedFromStripe(opts: {
  milestoneId: string;
  reason: string;
}) {
  const milestone = await prisma.paymentMilestone.findUnique({
    where: { id: opts.milestoneId },
  });
  if (!milestone) return;
  if (
    milestone.status === MilestoneStatus.PAID ||
    milestone.status === MilestoneStatus.CANCELLED
  ) {
    return;
  }
  await prisma.paymentMilestone.update({
    where: { id: milestone.id },
    data: { status: MilestoneStatus.FAILED },
  });
  await notifyDepositFailed(milestone.id, opts.reason);
}

/** Marque une facture ERP payée depuis une Invoice Stripe Billing (abonnement). */
export async function markInvoicePaidFromStripeBilling(opts: {
  erpInvoiceId: string;
  paymentIntentId?: string | null;
  amountCents: number;
  feeCents?: number | null;
  method: PaymentMethod;
}): Promise<{ duplicate: boolean }> {
  if (opts.paymentIntentId) {
    const existing = await prisma.payment.findUnique({
      where: { stripePaymentIntentId: opts.paymentIntentId },
    });
    if (existing) return { duplicate: true };
  }

  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: opts.erpInvoiceId },
      include: { ...BALANCE_INCLUDE, payments: true },
    });
    if (invoice.status === InvoiceStatus.PAID) return;

    const remaining = invoiceBalance(invoice).dueCents;
    if (remaining <= 0) {
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: InvoiceStatus.PAID },
      });
      return;
    }

    await tx.payment.create({
      data: {
        invoiceId: invoice.id,
        amountCents: remaining,
        paidAt: new Date(),
        method: opts.method,
        reference: opts.paymentIntentId ?? null,
        notes: "Prélèvement Stripe Billing",
        stripePaymentIntentId: opts.paymentIntentId ?? null,
        feeCents: opts.feeCents ?? null,
      },
    });
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: InvoiceStatus.PAID },
    });
  });

  const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
  await sendPaymentReceipt(opts.erpInvoiceId, opts.amountCents);
  return { duplicate: false };
}

export type Db = Prisma.TransactionClient | typeof prisma;
