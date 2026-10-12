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
import {
  initialPlan,
  parsePaymentPlan,
  parsePaymentPlanOffer,
  planTemplate,
} from "@/lib/quotes/payment-plans.js";
import { assertMilestoneInvoiced, assertQuoteSigned } from "@/lib/invoices/workflow.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";

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

  // Formule du devis (retenue, sinon celle de l'émission) ; devis historique : réglages 2 fois.
  const quote = await db.invoice.findUnique({
    where: { id: quoteId },
    select: { paymentPlanOffer: true, paymentPlan: true },
  });
  const offer = parsePaymentPlanOffer(quote?.paymentPlanOffer);
  const template =
    offer === null
      ? await loadDepositTemplateFromSettings()
      : planTemplate(parsePaymentPlan(quote?.paymentPlan) ?? initialPlan(offer), await getCompanySettings());
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

  if (milestone.checkoutUrl) {
    return milestone;
  }
  // Pas de lien de paiement avant la signature, ni pour un 2e acompte en attente de son étape.
  await assertQuoteSigned(milestone.quoteId);
  if (milestone.quote.paymentPlan === "THREE" && milestone.position === 2 && milestone.status === MilestoneStatus.PENDING && !milestone.triggeredAt) {
    throw new MilestonePaymentError("Ce 2e acompte attend l'étape de projet prévue", 409);
  }

  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled) {
    throw new MilestonePaymentError(
      "Stripe désactivé. Collez un lien de paiement sur le jalon (Réglages > Paiements).",
      400,
    );
  }

  const quoteRef = milestone.quote.number ?? "brouillon";
  const depositTotal =
    (await prisma.paymentMilestone.count({ where: { quoteId: milestone.quoteId } })) ||
    2;
  const checkoutUrl = buildPayUrl("milestone", milestone.id);
  const clientEmail = decryptOptional(milestone.quote.client.emailEncrypted);

  const updated = await prisma.paymentMilestone.update({
    where: { id: milestone.id },
    data: {
      checkoutUrl,
      status:
        milestone.status === MilestoneStatus.PENDING ||
        milestone.status === MilestoneStatus.OVERDUE ||
        milestone.status === MilestoneStatus.FAILED
          ? MilestoneStatus.DUE
          : milestone.status,
    },
    include: { quote: { include: { client: true } } },
  });

  if (milestone.invoiceId) {
    await prisma.invoice.update({
      where: { id: milestone.invoiceId },
      data: { checkoutUrl },
    });
  }

  if (opts.sendEmail !== false && checkoutUrl && clientEmail) {
    const brand = buildEmailBrand(settings);
    const content = renderDepositCheckoutEmail({
      brand,
      settings,
      brandPrimaryColor: settings.brandPrimaryColor,
      clientFirstName: milestone.quote.client.firstName,
      clientName: milestone.quote.client.displayName,
      quoteNumber: quoteRef,
      amountCents: milestone.amountCents,
      checkoutUrl,
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

/** Colle un lien de paiement à la main et envoie l'email optionnel. */
export async function setManualMilestonePaymentLink(
  milestoneId: string,
  checkoutUrl: string,
  opts: { sendEmail?: boolean } = {},
) {
  let url: URL;
  try {
    url = new URL(checkoutUrl.trim());
  } catch {
    throw new MilestonePaymentError("URL de paiement invalide", 400);
  }
  if (url.protocol !== "https:") {
    throw new MilestonePaymentError("Le lien doit être en https://", 400);
  }

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
  await assertQuoteSigned(milestone.quoteId);
  assertMilestoneInvoiced(milestone);

  const settings = await getCompanySettings();
  const updated = await prisma.paymentMilestone.update({
    where: { id: milestone.id },
    data: {
      checkoutUrl: url.toString(),
      revolutOrderId: null,
      status:
        milestone.status === MilestoneStatus.PENDING ||
        milestone.status === MilestoneStatus.OVERDUE ||
        milestone.status === MilestoneStatus.FAILED
          ? MilestoneStatus.DUE
          : milestone.status,
    },
    include: { quote: { include: { client: true } } },
  });
  // Même lien sur la facture de l'échéance : visible depuis la fiche facture et ses emails.
  if (milestone.invoiceId) {
    await prisma.invoice.update({
      where: { id: milestone.invoiceId },
      data: { checkoutUrl: url.toString(), revolutOrderId: null },
    });
  }

  const clientEmail = decryptOptional(milestone.quote.client.emailEncrypted);
  const quoteRef = milestone.quote.number ?? "brouillon";
  const depositTotal =
    (await prisma.paymentMilestone.count({ where: { quoteId: milestone.quoteId } })) ||
    2;

  if (opts.sendEmail !== false && clientEmail) {
    const brand = buildEmailBrand(settings);
    const content = renderDepositCheckoutEmail({
      brand,
      settings,
      brandPrimaryColor: settings.brandPrimaryColor,
      clientFirstName: milestone.quote.client.firstName,
      clientName: milestone.quote.client.displayName,
      quoteNumber: quoteRef,
      amountCents: milestone.amountCents,
      checkoutUrl: url.toString(),
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
    // 3 fois : le 2e acompte n'a pas de date, il devient exigible à l'étape de projet cochée.
    const awaitsStep = quote.paymentPlan === "THREE" && m.position === 2;
    await prisma.paymentMilestone.update({
      where: { id: m.id },
      data: { dueDate: awaitsStep ? null : computeMilestoneDueDate(quote, m, settings, milestones) },
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
    // Sans Stripe, le jalon reste « À payer » : lien collé à la main ou virement.
    if (settings.moduleStripeEnabled) {
      try {
        await activateMilestoneCheckout(first.id, { sendEmail: true });
      } catch (err) {
        console.error("[milestone] activation acompte après validation devis", err);
      }
    }
  }
}

export async function activateDueMilestoneCheckouts(): Promise<number> {
  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled) return 0;
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

export async function markMilestonePaidManually(opts: {
  milestoneId: string;
  method: PaymentMethod;
  reference?: string | null;
  notes?: string | null;
  /** Reçu envoyé au client. Par défaut : oui. */
  notifyClient?: boolean;
}) {
  const milestoneBefore = await prisma.paymentMilestone.findUniqueOrThrow({
    where: { id: opts.milestoneId },
  });

  if (milestoneBefore.status === MilestoneStatus.PAID) {
    throw new MilestonePaymentError("Jalon déjà payé", 409);
  }
  // Ordre imposé : devis signé, puis facture d'acompte, puis paiement.
  await assertQuoteSigned(milestoneBefore.quoteId);
  assertMilestoneInvoiced(milestoneBefore);

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

  await notifyDepositPaid(opts.milestoneId, { online: false, notifyClient: opts.notifyClient !== false });
  const { startProjectForQuote } = await import("@/lib/projects/lifecycle.js");
  await startProjectForQuote(updated.quoteId);
  return updated;
}

/**
 * Acompte réglé : reçu au client (facture d'acompte en PDF, acquittée) et, pour un
 * paiement en ligne, alerte à l'administrateur.
 */
export async function notifyDepositPaid(
  milestoneId: string,
  opts: { online?: boolean; notifyClient?: boolean } = {},
) {
  const milestone = await prisma.paymentMilestone.findUnique({
    where: { id: milestoneId },
    include: { quote: { include: { client: true } } },
  });
  if (!milestone) return;

  const settings = await getCompanySettings();
  const brand = buildEmailBrand(settings);
  const clientEmail = decryptOptional(milestone.quote.client.emailEncrypted);
  const quoteRef = milestone.quote.number ?? "";

  if (opts.notifyClient !== false && clientEmail && milestone.invoiceId) {
    const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
    await sendPaymentReceipt(milestone.invoiceId, milestone.amountCents);
  } else if (opts.notifyClient !== false && clientEmail) {
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

  // Paiement saisi à la main : l'administrateur le sait déjà.
  const adminEmail = opts.online === false ? null : settings.email?.trim();
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
