import {
  InvoiceDocumentType,
  InvoiceStatus,
  MilestoneStatus,
  PaymentMethod,
  QuoteStatus,
  type Prisma,
} from "@prisma/client";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import {
  buildEmailBrand,
  renderDepositCheckoutEmail,
  renderDepositPaidEmail,
  renderDepositFailedAdminEmail,
} from "@/lib/email/deposit-templates.js";
import {
  generateMilestoneInvoice,
  syncMilestoneOnInvoicePaid,
} from "@/lib/invoices/documentFlowService.js";
import {
  DEFAULT_MILESTONE_TEMPLATE,
  computeMilestoneAmounts,
  type MilestoneTemplate,
} from "@/lib/quotes/milestones.js";
import { prisma } from "@/lib/prisma.js";
import { createRevolutOrder } from "@/lib/revolut/merchantService.js";

export class MilestonePaymentError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function loadDepositTemplateFromSettings(): Promise<MilestoneTemplate[]> {
  const s = await getCompanySettings();
  const percents = [s.depositPercent1Bps, s.depositPercent2Bps];

  const labels = ["Acompte", "Solde"];
  const triggers = [
    "À la validation du devis",
    "À la livraison / fin de mission",
  ];

  if (percents.reduce((a, b) => a + b, 0) !== 10000) {
    return DEFAULT_MILESTONE_TEMPLATE;
  }

  return percents.map((percentBps, i) => ({
    position: i + 1,
    label: labels[i] ?? `Jalon ${i + 1}`,
    percentBps,
    triggerText: triggers[i] ?? triggers[triggers.length - 1]!,
  }));
}

export async function ensureQuoteMilestonesFromSettings(
  quoteId: string,
  totalCents: number,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const existing = await db.paymentMilestone.count({ where: { quoteId } });
  if (existing > 0) {
    return db.paymentMilestone.findMany({
      where: { quoteId },
      orderBy: { position: "asc" },
    });
  }

  const template = await loadDepositTemplateFromSettings();
  const amounts = computeMilestoneAmounts(totalCents, template);
  await db.paymentMilestone.createMany({
    data: amounts.map((m) => ({
      quoteId,
      position: m.position,
      label: m.label,
      percentBps: m.percentBps,
      amountCents: m.amountCents,
      triggerText: m.triggerText,
      status: MilestoneStatus.PENDING,
    })),
  });

  return db.paymentMilestone.findMany({
    where: { quoteId },
    orderBy: { position: "asc" },
  });
}

function computeMilestoneDueDate(
  quote: { issueDate: Date | null; validUntil: Date | null },
  milestone: { position: number },
  settings: Awaited<ReturnType<typeof getCompanySettings>>,
  siblings: Array<{ position: number }>,
): Date {
  const now = new Date();
  if (milestone.position === 1) return now;

  const maxPos = Math.max(...siblings.map((s) => s.position), milestone.position);
  const isLast = milestone.position === maxPos;
  if (isLast) {
    if (quote.validUntil) return quote.validUntil;
    const base = quote.issueDate ?? now;
    return new Date(base.getTime() + 90 * 86400000);
  }

  // Jalon intermédiaire historique (devis déjà en base à 3 jalons).
  const base = quote.issueDate ?? now;
  const end = quote.validUntil?.getTime() ?? base.getTime() + 90 * 86400000;
  const span = end - base.getTime();
  const midMs = span * (settings.projectMilestoneMidBps / 10000);
  return new Date(base.getTime() + Math.max(86400000, midMs));
}

export async function activateMilestoneCheckout(
  milestoneId: string,
  opts: { sendEmail?: boolean } = {},
) {
  const milestone = await prisma.paymentMilestone.findUniqueOrThrow({
    where: { id: milestoneId },
    include: { quote: { include: { client: true } } },
  });

  if (
    milestone.status === MilestoneStatus.PAID ||
    milestone.status === MilestoneStatus.CANCELLED
  ) {
    throw new MilestonePaymentError("Ce jalon est déjà réglé ou annulé", 409);
  }

  if (milestone.checkoutUrl && milestone.revolutOrderId) {
    return milestone;
  }

  const settings = await getCompanySettings();
  const quoteRef = milestone.quote.number ?? "brouillon";
  const depositTotal =
    (await prisma.paymentMilestone.count({ where: { quoteId: milestone.quoteId } })) ||
    2;
  const isLast =
    milestone.position === depositTotal ||
    /solde/i.test(milestone.label);
  const description = isLast
    ? `Solde - devis ${quoteRef}`
    : `${milestone.label} - devis ${quoteRef}`;

  const clientEmail = decryptOptional(milestone.quote.client.emailEncrypted);
  const order = await createRevolutOrder({
    amountCents: milestone.amountCents,
    description,
    customerEmail: clientEmail,
    reference: milestone.id,
  });

  const updated = await prisma.paymentMilestone.update({
    where: { id: milestone.id },
    data: {
      revolutOrderId: order.id,
      checkoutUrl: order.checkoutUrl,
      status:
        milestone.status === MilestoneStatus.PENDING ||
        milestone.status === MilestoneStatus.OVERDUE ||
        milestone.status === MilestoneStatus.FAILED
          ? MilestoneStatus.DUE
          : milestone.status,
    },
    include: { quote: { include: { client: true } } },
  });

  if (opts.sendEmail !== false && order.checkoutUrl && clientEmail) {
    const brand = buildEmailBrand(settings);
    const content = renderDepositCheckoutEmail({
      brand,
      settings,
      brandPrimaryColor: settings.brandPrimaryColor,
      clientFirstName: milestone.quote.client.firstName,
      clientName: milestone.quote.client.displayName,
      quoteNumber: quoteRef,
      amountCents: milestone.amountCents,
      checkoutUrl: order.checkoutUrl,
      depositIndex: milestone.position,
      depositTotal,
      label: milestone.label,
    });
    await mailEnqueue({
      to: clientEmail,
      subject: content.subject,
      text: content.text,
      html: content.html,
      clientId: milestone.quote.clientId,
      documentId: milestone.quoteId,
      documentNumber: quoteRef,
      kind: "deposit_checkout",
      bodyTextForMessage: content.text,
    });
  }

  return updated;
}

/** Prépare les jalons d'acompte à l'émission du devis (sans lien Revolut). */
export async function prepareFirstDepositCheckoutOnQuoteSent(quoteId: string) {
  const quote = await prisma.invoice.findUniqueOrThrow({
    where: { id: quoteId },
    include: { client: true },
  });
  if (quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new MilestonePaymentError("Document invalide", 400);
  }
  if (quote.quoteStatus !== QuoteStatus.SENT) return;

  await ensureQuoteMilestonesFromSettings(quoteId, quote.totalCents);
}

export async function onQuoteAcceptedByClient(quoteId: string) {
  const quote = await prisma.invoice.findUniqueOrThrow({
    where: { id: quoteId },
    include: { client: true },
  });
  if (quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new MilestonePaymentError("Document invalide", 400);
  }

  await ensureQuoteMilestonesFromSettings(quoteId, quote.totalCents);

  const settings = await getCompanySettings();
  const milestones = await prisma.paymentMilestone.findMany({
    where: { quoteId },
    orderBy: { position: "asc" },
  });

  for (const m of milestones) {
    await prisma.paymentMilestone.update({
      where: { id: m.id },
      data: { dueDate: computeMilestoneDueDate(quote, m, settings, milestones) },
    });
  }

  const first = milestones[0];
  if (
    first &&
    first.amountCents > 0 &&
    first.status !== MilestoneStatus.PAID &&
    first.status !== MilestoneStatus.CANCELLED
  ) {
    await prisma.paymentMilestone.update({
      where: { id: first.id },
      data: {
        status:
          first.status === MilestoneStatus.PENDING ||
          first.status === MilestoneStatus.FAILED
            ? MilestoneStatus.DUE
            : first.status,
      },
    });
    try {
      await activateMilestoneCheckout(first.id, { sendEmail: true });
    } catch (err) {
      console.error("[milestone] activation acompte après validation devis", err);
    }
  }
}

export async function activateDueMilestoneCheckouts(): Promise<number> {
  const settings = await getCompanySettings();
  const leadDays = settings.paymentButtonLeadDays ?? 7;
  const threshold = new Date();
  threshold.setDate(threshold.getDate() + leadDays);

  const due = await prisma.paymentMilestone.findMany({
    where: {
      position: { gt: 1 },
      status: { in: [MilestoneStatus.PENDING, MilestoneStatus.OVERDUE] },
      dueDate: { lte: threshold },
      checkoutUrl: null,
      quote: { quoteStatus: QuoteStatus.ACCEPTED },
    },
    orderBy: { dueDate: "asc" },
    take: 20,
  });

  let activated = 0;
  for (const m of due) {
    try {
      await activateMilestoneCheckout(m.id, { sendEmail: true });
      activated++;
    } catch (err) {
      console.error(`[milestone] activate checkout ${m.id}`, err);
    }
  }

  await prisma.paymentMilestone.updateMany({
    where: {
      status: MilestoneStatus.DUE,
      dueDate: { lt: new Date() },
    },
    data: { status: MilestoneStatus.OVERDUE },
  });

  return activated;
}

export async function markMilestonePaidFromRevolut(opts: {
  milestoneId: string;
  revolutOrderId: string;
  revolutPaymentId?: string | null;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  const milestoneBefore = await prisma.paymentMilestone.findUnique({
    where: { id: opts.milestoneId },
  });
  if (!milestoneBefore) {
    throw new MilestonePaymentError("Jalon introuvable", 404);
  }
  if (!milestoneBefore.invoiceId && milestoneBefore.status !== MilestoneStatus.PAID) {
    await generateMilestoneInvoice(milestoneBefore.id);
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.revolutWebhookEvent.findUnique({
      where: { eventId: opts.eventId },
    });
    if (existing) return { duplicate: true as const, milestone: null };

    const milestone = await tx.paymentMilestone.findUnique({
      where: { id: opts.milestoneId },
    });
    if (!milestone) {
      throw new MilestonePaymentError("Jalon introuvable", 404);
    }

    await tx.revolutWebhookEvent.create({
      data: {
        eventId: opts.eventId,
        eventType: opts.eventType,
        payload: opts.payload as Prisma.InputJsonValue,
        milestoneId: milestone.id,
      },
    });

    if (milestone.status === MilestoneStatus.PAID) {
      return { duplicate: false as const, milestone };
    }

    const invoiceId = milestone.invoiceId;
    if (!invoiceId) {
      throw new MilestonePaymentError("Facture d'acompte introuvable", 500);
    }

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });

    const paidSoFar = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
    const remaining = invoice.totalCents - paidSoFar;
    if (remaining > 0) {
      await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          amountCents: remaining,
          paidAt: new Date(),
          method: PaymentMethod.CARD,
          reference: opts.revolutPaymentId ?? opts.revolutOrderId,
          notes: "Paiement Revolut Merchant",
        },
      });
      if (invoice.status !== InvoiceStatus.PAID) {
        await tx.invoice.update({
          where: { id: invoice.id },
          data: { status: InvoiceStatus.PAID },
        });
      }
      await syncMilestoneOnInvoicePaid(invoice.id, tx);
    }

    const updated = await tx.paymentMilestone.update({
      where: { id: milestone.id },
      data: {
        status: MilestoneStatus.PAID,
        paidAt: new Date(),
        paymentMethod: PaymentMethod.CARD,
        revolutOrderId: opts.revolutOrderId,
        revolutPaymentId: opts.revolutPaymentId ?? null,
        checkoutUrl: null,
      },
    });

    return { duplicate: false as const, milestone: updated };
  });
}

export async function markMilestoneFailedFromRevolut(opts: {
  milestoneId: string;
  revolutOrderId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.revolutWebhookEvent.findUnique({
      where: { eventId: opts.eventId },
    });
    if (existing) return { duplicate: true as const };

    await tx.revolutWebhookEvent.create({
      data: {
        eventId: opts.eventId,
        eventType: opts.eventType,
        payload: opts.payload as Prisma.InputJsonValue,
        milestoneId: opts.milestoneId,
      },
    });

    await tx.paymentMilestone.update({
      where: { id: opts.milestoneId },
      data: {
        status: MilestoneStatus.FAILED,
        revolutOrderId: opts.revolutOrderId,
        checkoutUrl: null,
      },
    });

    return { duplicate: false as const };
  });
}

export async function markMilestonePaidManually(opts: {
  milestoneId: string;
  method: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
}) {
  const milestoneBefore = await prisma.paymentMilestone.findUniqueOrThrow({
    where: { id: opts.milestoneId },
  });

  if (milestoneBefore.status === MilestoneStatus.PAID) {
    throw new MilestonePaymentError("Jalon déjà payé", 409);
  }

  if (!milestoneBefore.invoiceId) {
    await generateMilestoneInvoice(milestoneBefore.id);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const milestone = await tx.paymentMilestone.findUniqueOrThrow({
      where: { id: opts.milestoneId },
    });

    const invoiceId = milestone.invoiceId;
    if (!invoiceId) {
      throw new MilestonePaymentError("Facture d'acompte introuvable", 500);
    }

    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { payments: true },
    });

    const paidSoFar = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
    const remaining = invoice.totalCents - paidSoFar;
    if (remaining > 0) {
      await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          amountCents: remaining,
          paidAt: new Date(),
          method: opts.method,
          reference: opts.reference?.trim() || null,
          notes: opts.notes?.trim() || "Paiement manuel",
        },
      });
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: InvoiceStatus.PAID },
      });
      await syncMilestoneOnInvoicePaid(invoice.id, tx);
    }

    return tx.paymentMilestone.update({
      where: { id: milestone.id },
      data: {
        status: MilestoneStatus.PAID,
        paidAt: new Date(),
        paymentMethod: opts.method,
        manualReference: opts.reference?.trim() || null,
        manualNotes: opts.notes?.trim() || null,
        checkoutUrl: null,
      },
    });
  });

  await notifyDepositPaid(opts.milestoneId);
  return updated;
}

export async function notifyDepositPaid(milestoneId: string) {
  const milestone = await prisma.paymentMilestone.findUnique({
    where: { id: milestoneId },
    include: { quote: { include: { client: true } } },
  });
  if (!milestone) return;

  const settings = await getCompanySettings();
  const brand = buildEmailBrand(settings);
  const clientEmail = decryptOptional(milestone.quote.client.emailEncrypted);
  const quoteRef = milestone.quote.number ?? "";

  if (clientEmail) {
    const content = renderDepositPaidEmail({
      brand,
      settings,
      clientFirstName: milestone.quote.client.firstName,
      clientName: milestone.quote.client.displayName,
      quoteNumber: quoteRef,
      amountCents: milestone.amountCents,
      depositIndex: milestone.position,
      label: milestone.label,
    });
    await mailEnqueue({
      to: clientEmail,
      subject: content.subject,
      text: content.text,
      clientId: milestone.quote.clientId,
      documentId: milestone.quoteId,
      documentNumber: quoteRef,
      kind: "payment_received",
      bodyTextForMessage: content.text,
    });
  }

  const adminEmail = settings.email?.trim();
  if (adminEmail) {
    const content = renderDepositFailedAdminEmail({
      brand,
      quoteNumber: quoteRef,
      amountCents: milestone.amountCents,
      clientName: milestone.quote.client.displayName,
      reason: `Acompte ${milestone.position} payé en ligne`,
      isSuccess: true,
    });
    await mailEnqueue({
      to: adminEmail,
      subject: content.subject,
      text: content.text,
      kind: "deposit_paid_admin",
      bodyTextForMessage: content.text,
    });
  }
}

export async function notifyDepositFailed(milestoneId: string, reason: string) {
  const milestone = await prisma.paymentMilestone.findUnique({
    where: { id: milestoneId },
    include: { quote: { include: { client: true } } },
  });
  if (!milestone) return;

  const settings = await getCompanySettings();
  const adminEmail = settings.email?.trim();
  if (!adminEmail) return;

  const brand = buildEmailBrand(settings);
  const content = renderDepositFailedAdminEmail({
    brand,
    quoteNumber: milestone.quote.number ?? "",
    amountCents: milestone.amountCents,
    clientName: milestone.quote.client.displayName,
    reason,
    isSuccess: false,
  });
  await mailEnqueue({
    to: adminEmail,
    subject: content.subject,
    text: content.text,
    kind: "deposit_failed_admin",
    bodyTextForMessage: content.text,
  });
}
