import { BALANCE_INCLUDE, invoiceBalance } from "@/lib/invoices/balance.js";
import { applySettledStatus, lockInvoice } from "@/lib/invoices/balance-status.js";
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
import { formatEUR } from "@/lib/money.js";
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

  // Un paiement reçu n'est jamais rejeté (audit du 25/10/2026) : sans facture possible, il est enregistré sans facture
  // et l'administrateur est alerté. Une erreur ici renverrait 500 à Stripe en boucle, sans trace de l'argent reçu.
  if (milestoneId) {
    const milestoneBefore = await prisma.paymentMilestone.findUnique({
      where: { id: milestoneId },
    });
    if (!milestoneBefore) {
      return recordUnattachedPayment(input, null, "l'échéance payée est introuvable dans l'ERP");
    }
    if (!milestoneBefore.invoiceId && milestoneBefore.status !== MilestoneStatus.PAID) {
      try {
        // Facture d'acompte, de solde (dernière échéance) ou simple (comptant) : generateMilestoneInvoice choisit.
        await generateMilestoneInvoice(milestoneBefore.id);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return recordUnattachedPayment(input, milestoneBefore.id, `la facture de l'échéance « ${milestoneBefore.label} » n'a pas pu être émise (${reason})`);
      }
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

    const invoice = invoiceId
      ? await tx.invoice.findUnique({
          where: { id: invoiceId },
          include: { ...BALANCE_INCLUDE, payments: true },
        })
      : null;
    if (!invoice || invoice.documentType !== InvoiceDocumentType.INVOICE) {
      return { unattached: true as const };
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
  if ("unattached" in result) {
    return recordUnattachedPayment(input, milestoneId, "la facture du paiement est introuvable dans l'ERP");
  }

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
      await sendPaymentReceipt(result.invoiceId, input.amountCents, undefined, { review: { family: "payment_receipt", origin: "WEBHOOK" } });
    }
  }

  return result;
}

/**
 * Paiement Stripe sans facture rattachable : enregistré sans facture (livre des recettes), échéance soldée pour
 * arrêter les rappels au client, et alerte à l'administrateur pour régulariser. Idempotent sur le PaymentIntent.
 */
async function recordUnattachedPayment(
  input: OnlinePaymentInput,
  milestoneId: string | null,
  reason: string,
): Promise<{ duplicate: boolean; invoiceId: null; milestoneId: string | null }> {
  const created = await prisma.$transaction(async (tx) => {
    if (await tx.payment.findUnique({ where: { stripePaymentIntentId: input.paymentIntentId } })) return false;
    await tx.payment.create({
      data: {
        invoiceId: null,
        amountCents: input.amountCents,
        paidAt: new Date(),
        method: input.method,
        reference: input.paymentIntentId,
        notes: "Paiement Stripe sans facture : à régulariser",
        stripePaymentIntentId: input.paymentIntentId,
        feeCents: input.feeCents ?? null,
      },
    });
    if (milestoneId) {
      await tx.paymentMilestone.updateMany({
        where: { id: milestoneId, status: { notIn: [MilestoneStatus.PAID, MilestoneStatus.CANCELLED] } },
        data: { status: MilestoneStatus.PAID, paidAt: new Date(), paymentMethod: input.method, checkoutUrl: null },
      });
    }
    return true;
  });
  if (!created) return { duplicate: true, invoiceId: null, milestoneId };
  const { alertAdmin } = await import("@/lib/stripe/alert.js");
  await alertAdmin(
    "Paiement Stripe reçu sans facture",
    `Paiement Stripe de ${formatEUR(input.amountCents)} reçu (${input.paymentIntentId}) : ${reason}. Le paiement est enregistré sans facture ; émettez la facture correspondante ou remboursez le client.`,
  ).catch(() => undefined);
  return { duplicate: false, invoiceId: null, milestoneId };
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

  // Montant réellement prélevé (amount_paid), jamais le reste dû : une facture réglée à la main avant le prélèvement
  // garde les deux paiements, et le trop-perçu est signalé pour remboursement.
  if (opts.amountCents <= 0) return { duplicate: false };
  let overpaidCents = 0;
  let invoiceNumber: string | null = null;
  const recorded = await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, opts.erpInvoiceId);
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: opts.erpInvoiceId },
      include: BALANCE_INCLUDE,
    });
    invoiceNumber = invoice.number;
    // Sans PaymentIntent, pas de clé d'idempotence : un renvoi de l'événement sur une facture soldée n'ajoute rien.
    if (!opts.paymentIntentId && invoice.status === InvoiceStatus.PAID) return false;
    const due = Math.max(0, invoiceBalance(invoice).dueCents);
    await tx.payment.create({
      data: {
        invoiceId: invoice.id,
        amountCents: opts.amountCents,
        paidAt: new Date(),
        method: opts.method,
        reference: opts.paymentIntentId ?? null,
        notes: due > 0 ? "Prélèvement Stripe Billing" : "Prélèvement Stripe Billing (facture déjà soldée)",
        stripePaymentIntentId: opts.paymentIntentId ?? null,
        feeCents: opts.feeCents ?? null,
      },
    });
    if (opts.amountCents > due) overpaidCents = opts.amountCents - due;
    await applySettledStatus(tx, invoice.id);
    return true;
  });
  if (!recorded) return { duplicate: true };

  if (overpaidCents > 0) {
    const { alertAdmin } = await import("@/lib/stripe/alert.js");
    await alertAdmin(
      `Trop-perçu sur la facture ${invoiceNumber ?? ""}`.trim(),
      `Prélèvement Stripe de ${formatEUR(opts.amountCents)} reçu, dont ${formatEUR(overpaidCents)} au-delà du reste dû (facture déjà réglée en tout ou partie). Le prélèvement est enregistré en entier ; remboursez le trop-perçu depuis la fiche de la facture (« Enregistrer un remboursement »).`,
    ).catch(() => undefined);
  }

  const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
  await sendPaymentReceipt(opts.erpInvoiceId, opts.amountCents, undefined, { review: { family: "payment_receipt", origin: "WEBHOOK" } });
  return { duplicate: false };
}

export type Db = Prisma.TransactionClient | typeof prisma;
