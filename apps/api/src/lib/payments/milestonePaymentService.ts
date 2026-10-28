import { BALANCE_INCLUDE, invoiceBalance } from "@/lib/invoices/balance.js";
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
import { PAYMENT_LINK_REFUSED, isAllowedPaymentUrl } from "@/lib/invoices/payment-link.js";
import {
  DEFAULT_MILESTONE_TEMPLATE,
  awaitsProposalChoice,
  computeMilestoneAmounts,
  type MilestoneTemplate,
} from "@/lib/quotes/milestones.js";
import { prisma } from "@/lib/prisma.js";
import { applySettledStatus, lockInvoice } from "@/lib/invoices/balance-status.js";
import type { ReviewOptions } from "@/lib/email/review.js";
import {
  initialPlan,
  milestoneAmounts,
  parseBillingMode,
  parsePaymentPlan,
  parsePaymentPlanOffer,
  planSettingsOf,
  planTemplate,
} from "@/lib/quotes/payment-plans.js";
import { activeTotalInvoiceOf, assertMilestoneInvoiced, assertNoTotalInvoice, assertQuoteSigned, milestoneInvoiceKind } from "@/lib/invoices/workflow.js";
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

  if (await awaitsProposalChoice(quoteId, db)) return [];
  // Formule du devis (retenue, sinon celle de l'émission) ; devis historique : réglages 2 fois.
  const quote = await db.invoice.findUnique({
    where: { id: quoteId },
    select: { paymentPlanOffer: true, paymentPlan: true, depositBaseCents: true, billingMode: true, paymentScheduleSnapshot: true },
  });
  const offer = parsePaymentPlanOffer(quote?.paymentPlanOffer);
  // Abonnement seul : aucun jalon (donc ni acompte exigible ni lien de paiement).
  if (offer === "NONE") return [];
  const mode = parseBillingMode(quote?.billingMode);
  const template =
    offer === null
      ? await loadDepositTemplateFromSettings()
      : planTemplate(parsePaymentPlan(quote?.paymentPlan) ?? initialPlan(offer), planSettingsOf(quote ?? {}, await getCompanySettings()), mode);
  // Base figée à l'émission (partie ponctuelle) : elle prime sur le montant passé.
  const amounts = milestoneAmounts(quote?.depositBaseCents ?? totalCents, template, offer === null ? null : mode);
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
  opts: { sendEmail?: boolean; review?: ReviewOptions } = {},
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
  // Pas de lien de paiement avant la signature, ni pour un 2e acompte en attente de son étape, ni sur un devis déjà
  // facturé en totalité (facture libre rattachée ou conversion).
  await assertQuoteSigned(milestone.quoteId);
  await assertNoTotalInvoice(milestone.quoteId);
  // Devis avec mode (échéances datées) : aucune étape de projet n'est attendue.
  if (!milestone.quote.billingMode && milestone.quote.paymentPlan === "THREE" && milestone.position === 2 && milestone.status === MilestoneStatus.PENDING && !milestone.triggeredAt) {
    throw new MilestonePaymentError("Ce 2e acompte attend l'étape de projet prévue", 409);
  }

  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled) {
    throw new MilestonePaymentError(
      "Stripe désactivé. Collez un lien de paiement sur le jalon (Réglages > Paiements).",
      400,
    );
  }

  // Dernière échéance : sa facture de solde (marché moins acomptes réglés) est émise avant le lien, jamais à la
  // réception du paiement. Échec (acompte encore dû, devis déjà facturé) : pas de lien, l'erreur remonte à l'appelant.
  if (!milestone.invoiceId && (await milestoneInvoiceKind(milestone)) === "BALANCE") {
    const { generateBalanceInvoice } = await import("@/lib/invoices/documentFlowService.js");
    const { invoice } = await generateBalanceInvoice(milestone.quoteId, { milestoneId: milestone.id });
    milestone.invoiceId = invoice.id;
    // Montant du jalon remis au solde réel par la facture de solde : l'e-mail annonce celui-là.
    milestone.amountCents = invoice.totalCents;
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
    const content = await renderDepositCheckoutEmail({
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
    }, { review: opts.review ?? { family: "payment_link", origin: "ADMIN_ACTION" } });
  }

  return updated;
}

/**
 * E-mail « lien de paiement de l'acompte » d'une échéance qui a déjà son lien (« Vérifier l'e-mail ») : brouillon seul,
 * ou envoi avec l'objet et le texte relus. null : pas de lien ou pas d'adresse client.
 */
export async function sendMilestoneLinkEmail(
  milestoneId: string,
  opts: { draft?: boolean; subject?: string; text?: string } = {},
): Promise<{ to: string; subject: string; text: string; attachments: string[] } | { sent: true } | null> {
  const milestone = await prisma.paymentMilestone.findUniqueOrThrow({
    where: { id: milestoneId },
    include: { quote: { include: { client: true } } },
  });
  const clientEmail = decryptOptional(milestone.quote.client.emailEncrypted);
  if (!milestone.checkoutUrl || !clientEmail) return null;
  const settings = await getCompanySettings();
  const quoteRef = milestone.quote.number ?? "brouillon";
  const depositTotal = (await prisma.paymentMilestone.count({ where: { quoteId: milestone.quoteId } })) || 2;
  const content = await renderDepositCheckoutEmail({
    brand: buildEmailBrand(settings),
    settings,
    brandPrimaryColor: settings.brandPrimaryColor,
    clientFirstName: milestone.quote.client.firstName,
    clientName: milestone.quote.client.displayName,
    quoteNumber: quoteRef,
    amountCents: milestone.amountCents,
    checkoutUrl: milestone.checkoutUrl,
    depositIndex: milestone.position,
    depositTotal,
    label: milestone.label,
  });
  if (opts.draft) return { to: clientEmail, subject: content.subject, text: content.text, attachments: [] };
  const text = opts.text?.trim();
  // Texte relu : mise en page refaite à l'envoi depuis le texte (le lien y reste en clair).
  await mailEnqueue({
    to: clientEmail,
    subject: opts.subject?.trim() || content.subject,
    text: text || content.text,
    ...(text && text !== content.text.trim() ? {} : { html: content.html }),
    clientId: milestone.quote.clientId,
    documentId: milestone.quoteId,
    documentNumber: quoteRef,
    kind: "deposit_checkout",
    bodyTextForMessage: text || content.text,
  });
  return { sent: true };
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
  if (!isAllowedPaymentUrl(checkoutUrl)) throw new MilestonePaymentError(PAYMENT_LINK_REFUSED, 400);

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

  if (opts.sendEmail !== false) await sendMilestoneLinkEmail(milestone.id);

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

  // Devis avec mode (24/10/2026) : échéances datées depuis la signature, tous les installmentIntervalDays.
  const dated = parseBillingMode(quote.billingMode) !== null;
  const signedAt = quote.quoteDecidedAt ?? new Date();
  for (const m of milestones) {
    // 3 fois historique : le 2e acompte n'a pas de date, il devient exigible à l'étape de projet cochée.
    const awaitsStep = !dated && quote.paymentPlan === "THREE" && m.position === 2;
    const dueDate = dated
      ? new Date(signedAt.getTime() + (m.position - 1) * planSettingsOf(quote, settings).installmentIntervalDays * 86400000)
      : awaitsStep
        ? null
        : computeMilestoneDueDate(quote, m, settings, milestones);
    await prisma.paymentMilestone.update({ where: { id: m.id }, data: { dueDate } });
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
        await activateMilestoneCheckout(first.id, { sendEmail: true, review: { family: "payment_link", origin: "CLIENT_ACTION", clientWaiting: true } });
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
    // Devis facturé en totalité entre-temps : rien à payer, pas d'erreur à journaliser à chaque passage.
    if (await activeTotalInvoiceOf(m.quoteId)) continue;
    try {
      await activateMilestoneCheckout(m.id, { sendEmail: true, review: { family: "payment_link", origin: "WORKER" } });
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
  /** Date du règlement (virement reçu, chèque encaissé) ; par défaut : maintenant. */
  paidAt?: Date;
}) {
  const milestoneBefore = await prisma.paymentMilestone.findUniqueOrThrow({
    where: { id: opts.milestoneId },
  });

  if (milestoneBefore.status === MilestoneStatus.PAID) {
    throw new MilestonePaymentError("Jalon déjà payé", 409);
  }
  if (milestoneBefore.status === MilestoneStatus.CANCELLED) {
    throw new MilestonePaymentError("Jalon annulé : aucun paiement à y enregistrer", 409);
  }
  const paidAt = opts.paidAt ?? new Date();
  let recorded: { id: string; amountCents: number } | null = null;
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

    // Verrou puis reste dû relu : un autre règlement ou un avoir enregistré entre-temps est pris en compte.
    await lockInvoice(tx, invoiceId);
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: BALANCE_INCLUDE,
    });

    const remaining = invoiceBalance(invoice).dueCents;
    if (remaining > 0) {
      const payment = await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          amountCents: remaining,
          paidAt,
          method: opts.method,
          reference: opts.reference?.trim() || null,
          notes: opts.notes?.trim() || "Paiement manuel",
        },
      });
      recorded = { id: payment.id, amountCents: payment.amountCents };
      await applySettledStatus(tx, invoice.id);
    }

    return tx.paymentMilestone.update({
      where: { id: milestone.id },
      data: {
        status: MilestoneStatus.PAID,
        paidAt,
        paymentMethod: opts.method,
        manualReference: opts.reference?.trim() || null,
        manualNotes: opts.notes?.trim() || null,
        checkoutUrl: null,
      },
    });
  });

  await notifyDepositPaid(opts.milestoneId, { online: false, notifyClient: opts.notifyClient !== false, payment: recorded });
  const { onMilestonePaidForProject } = await import("@/lib/projects/lifecycle.js");
  await onMilestonePaidForProject(updated.id);
  return updated;
}

/**
 * Acompte réglé : reçu du règlement et facture d'acompte au client et, pour un
 * paiement en ligne, alerte à l'administrateur.
 */
export async function notifyDepositPaid(
  milestoneId: string,
  /** payment : le règlement réellement enregistré (montant et reçu), pas le montant prévu du jalon. */
  opts: { online?: boolean; notifyClient?: boolean; payment?: { id: string; amountCents: number } | null } = {},
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

  // Paiement en ligne : webhook Stripe ; paiement noté à la main : suite à l'action de l'admin.
  const receiptReview: ReviewOptions = { family: "payment_receipt", origin: opts.online ? "WEBHOOK" : "ADMIN_ACTION" };
  if (opts.notifyClient !== false && clientEmail && milestone.invoiceId) {
    const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
    await sendPaymentReceipt(milestone.invoiceId, opts.payment?.amountCents ?? milestone.amountCents, opts.payment?.id, { review: receiptReview });
  } else if (opts.notifyClient !== false && clientEmail) {
    const content = await renderDepositPaidEmail({
      brand,
      settings,
      clientFirstName: milestone.quote.client.firstName,
      clientName: milestone.quote.client.displayName,
      quoteNumber: quoteRef,
      amountCents: milestone.amountCents,
      depositIndex: milestone.position,
      depositTotal: (await prisma.paymentMilestone.count({ where: { quoteId: milestone.quoteId } })) || 2,
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
    }, { review: receiptReview });
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
