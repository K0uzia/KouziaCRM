import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
  QuoteStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { assertQuoteSigned } from "@/lib/invoices/workflow.js";
import { getCompanySettings } from "@/lib/company.js";
import { allocateInvoiceNumber, allocateQuoteNumber } from "@/lib/invoices/numberingService.js";
import { ensureQuoteMilestones } from "@/lib/quotes/milestones.js";
import { computeDepositBaseCents, depositBaseOf } from "@/lib/invoices/totals.js";
import {
  applyPlanMilestones,
  effectiveOffer,
  initialPlan,
  isSubscriptionOnly,
  parsePaymentPlanOffer,
  PaymentPlanError,
  resolveAcceptedPlan,
  type PaymentPlan,
} from "@/lib/quotes/payment-plans.js";
import {
  buildClientSnapshot,
  type ClientSnapshot,
  generateMilestoneInvoice,
  generateBalanceInvoice,
  syncMilestoneOnInvoicePaid,
  assertQuoteEditable,
  DocumentFlowError,
} from "@/lib/invoices/documentFlowService.js";
import {
  activateSubscriptionsFromDocument,
  notifyStripeSubscriptionSetup,
} from "@/lib/subscriptions/activate-from-document.js";

export type { ClientSnapshot };
export {
  generateMilestoneInvoice,
  generateBalanceInvoice,
  syncMilestoneOnInvoicePaid,
  assertQuoteEditable,
  DocumentFlowError,
};
export {
  assessCreditNoteEligibility,
  createCreditNote,
  cancelInvoiceWithCreditNote,
  CreditNoteError,
} from "@/lib/invoices/credit-note-service.js";

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Émission d'une facture dans une transaction fournie.
 * L'activation des abonnements en fait partie : une facture émise dont
 * l'abonnement n'a pas pu être créé laisserait un numéro légal consommé
 * pour rien.
 */
export async function issueInvoiceWithin(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  issueDate: Date,
  dueDate: Date | undefined,
  settings: Awaited<ReturnType<typeof getCompanySettings>>,
) {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { lines: true },
  });

  if (invoice.status !== InvoiceStatus.DRAFT) {
    throw new Error("Seuls les brouillons peuvent être émis");
  }
  if (invoice.lines.length === 0) {
    throw new Error("Impossible d'émettre une facture sans lignes");
  }
  if (invoice.documentType !== InvoiceDocumentType.INVOICE) {
    throw new Error("Document invalide pour émission de facture");
  }

  const allocated = await allocateInvoiceNumber(issueDate, tx);
  const snapshot = await buildClientSnapshot(invoice.clientId, tx);

  const updated = await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      status: InvoiceStatus.ISSUED,
      number: allocated.number,
      sequenceYear: allocated.sequenceYear,
      sequenceNumber: allocated.sequenceNumber,
      issueDate,
      dueDate: dueDate ?? issueDate,
      issuedAt: new Date(),
      clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      nextReminderAt: addDays(dueDate ?? issueDate, settings.reminderInvoiceDays),
    },
    include: { lines: true, client: true, payments: true },
  });

  const subs = await activateSubscriptionsFromDocument(invoiceId, tx);
  return { ...updated, subscriptionsCreated: subs.created };
}

export async function issueInvoice(invoiceId: string, issueDate = new Date(), dueDate?: Date) {
  const settings = await getCompanySettings();
  const issued = await prisma.$transaction((tx) =>
    issueInvoiceWithin(tx, invoiceId, issueDate, dueDate, settings),
  );
  const lines = await prisma.invoiceLine.findMany({
    where: { invoiceId, subscriptionId: { not: null } },
    select: { subscriptionId: true },
  });
  await notifyStripeSubscriptionSetup(
    lines.map((l) => l.subscriptionId!).filter(Boolean),
  );
  return issued;
}

/** Émet un devis (numéro D-YYYY-NNN, QuoteStatus SENT) et crée les jalons acompte / solde. */
export async function issueQuote(
  quoteId: string,
  issueDate = new Date(),
  validUntil?: Date,
) {
  const settings = await getCompanySettings();
  const updated = await prisma.$transaction(async (tx) => {
    const quote = await tx.invoice.findUniqueOrThrow({
      where: { id: quoteId },
      include: { lines: true },
    });

    if (quote.documentType !== InvoiceDocumentType.QUOTE) {
      throw new Error("Ce document n'est pas un devis");
    }
    if (quote.status !== InvoiceStatus.DRAFT) {
      throw new Error("Seuls les brouillons de devis peuvent être émis");
    }
    if (quote.lines.length === 0) {
      throw new Error("Impossible d'émettre un devis sans lignes");
    }

    const allocated = await allocateQuoteNumber(issueDate, tx);
    const snapshot = await buildClientSnapshot(quote.clientId, tx);
    const validity =
      validUntil ??
      new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    // Offre de paiement figée à l'émission (seuil du 3 fois appliqué ici). Abonnement seul :
    // pas d'échéancier, chaque période est facturée par l'abonnement.
    // Base de l'acompte, du 2 ou 3 fois et du seuil : la partie ponctuelle (l'abonnement est
    // facturé à chaque période, il n'entre pas dans l'échéancier).
    const depositBaseCents = computeDepositBaseCents(quote.lines, quote.subtotalCents, quote.totalCents);
    const offer = isSubscriptionOnly(quote.lines)
      ? "NONE"
      : effectiveOffer(parsePaymentPlanOffer(quote.paymentPlanOffer), depositBaseCents, settings);

    const updated = await tx.invoice.update({
      where: { id: quoteId },
      data: {
        status: InvoiceStatus.ISSUED,
        quoteStatus: QuoteStatus.SENT,
        number: allocated.number,
        sequenceYear: allocated.sequenceYear,
        sequenceNumber: allocated.sequenceNumber,
        issueDate,
        validUntil: validity,
        dueDate: validity,
        issuedAt: new Date(),
        clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        nextReminderAt: addDays(issueDate, settings.reminderQuoteDays),
        paymentPlanOffer: offer,
        depositBaseCents,
      },
      include: { lines: true, client: true, payments: true },
    });

    // Jalons créés pendant le brouillon (affichage de la fiche, offre encore 2 fois) : retirés,
    // un devis d'abonnement seul n'en a aucun. Un brouillon n'a jamais de jalon payé ni facturé.
    if (offer === "NONE") await tx.paymentMilestone.deleteMany({ where: { quoteId, invoiceId: null } });
    if (offer === null) await ensureQuoteMilestones(quoteId, depositBaseCents, tx);
    else if (offer !== "NONE") await applyPlanMilestones(tx, quoteId, depositBaseCents, initialPlan(offer), settings);
    return updated;
  });

  return updated;
}

/**
 * Attribue un numéro officiel D-YYYY-NNN à un devis qui n'en a pas encore
 * (acceptation ou conversion sans émission préalable).
 */
export async function ensureQuoteHasOfficialNumber(
  tx: Prisma.TransactionClient,
  quoteId: string,
  issueDate = new Date(),
) {
  const quote = await tx.invoice.findUniqueOrThrow({ where: { id: quoteId } });
  if (quote.documentType !== InvoiceDocumentType.QUOTE || quote.number) {
    return quote;
  }

  const allocated = await allocateQuoteNumber(issueDate, tx);
  const snapshot = await buildClientSnapshot(quote.clientId, tx);
  const patch: Prisma.InvoiceUpdateInput = {
    number: allocated.number,
    sequenceYear: allocated.sequenceYear,
    sequenceNumber: allocated.sequenceNumber,
    issueDate: quote.issueDate ?? issueDate,
    issuedAt: quote.issuedAt ?? new Date(),
    clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
  };
  if (quote.status === InvoiceStatus.DRAFT) {
    patch.status = InvoiceStatus.ISSUED;
  }
  if (quote.quoteStatus === QuoteStatus.DRAFT) {
    patch.quoteStatus = QuoteStatus.SENT;
  }

  return tx.invoice.update({
    where: { id: quoteId },
    data: patch,
    include: { lines: true, client: true },
  });
}

/** Répare les devis sans numéro (données antérieures à la correction). */
export async function repairQuotesMissingNumbers(): Promise<number> {
  const quotes = await prisma.invoice.findMany({
    where: {
      documentType: InvoiceDocumentType.QUOTE,
      number: null,
      status: { not: InvoiceStatus.CANCELLED },
    },
    select: { id: true },
  });
  for (const q of quotes) {
    await prisma.$transaction((tx) => ensureQuoteHasOfficialNumber(tx, q.id));
  }
  return quotes.length;
}

/** Erreur métier sur une décision de devis (refus, acceptation en ligne). */
export class QuoteDecisionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_A_QUOTE"
      | "NOT_PENDING"
      | "ALREADY_INVOICED"
      | "DEPOSIT_REQUIRED",
  ) {
    super(message);
    this.name = "QuoteDecisionError";
  }
}

export type QuoteAcceptanceSource = "PORTAL" | "THREAD" | "ADMIN";

export type QuoteAcceptanceActor = {
  userId?: string | null;
  userEmail?: string | null;
};

/** Contexte technique du signataire (portail) conservé comme preuve. */
export type QuoteAcceptanceContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Signature depuis l'espace client, confirmée par un code envoyé par e-mail. */
export type QuoteSignature = {
  mode: "TYPED" | "DRAWN";
  /** Tracé PNG (data URL), mode DRAWN seulement */
  image?: string | null;
  /** Société représentée (client professionnel) */
  company?: string | null;
  emailMasked?: string | null;
  codeVerifiedAt: Date;
};

async function logQuoteAcceptance(
  quoteId: string,
  signerName: string,
  source: QuoteAcceptanceSource,
  opts: {
    threadId?: string | null;
    actor?: QuoteAcceptanceActor;
    context?: QuoteAcceptanceContext;
    signature?: QuoteSignature;
    originalPdfSha256?: string | null;
    paymentPlan?: PaymentPlan | null;
  } = {},
) {
  return prisma.quoteAcceptanceAudit.create({
    data: {
      quoteId,
      signerName: signerName.trim(),
      source,
      threadId: opts.threadId ?? null,
      userId: opts.actor?.userId ?? null,
      userEmail: opts.actor?.userEmail ?? null,
      ipAddress: opts.context?.ipAddress?.slice(0, 64) || null,
      userAgent: opts.context?.userAgent?.slice(0, 512) || null,
      signatureMode: opts.signature?.mode ?? null,
      signatureImage: opts.signature?.image ?? null,
      signerCompany: opts.signature?.company ?? null,
      verifiedEmailMasked: opts.signature?.emailMasked ?? null,
      codeVerifiedAt: opts.signature?.codeVerifiedAt ?? null,
      originalPdfSha256: opts.originalPdfSha256 ?? null,
      paymentPlan: opts.paymentPlan ?? null,
    },
  });
}

/**
 * Charge un devis en attente de décision client.
 * Un devis déjà facturé n'est plus décidable : la décision commerciale est actée.
 */
async function loadPendingQuote(tx: Prisma.TransactionClient, quoteId: string) {
  const quote = await tx.invoice.findUniqueOrThrow({ where: { id: quoteId } });

  if (quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new QuoteDecisionError("Ce document n'est pas un devis", "NOT_A_QUOTE");
  }
  if (quote.quoteStatus !== QuoteStatus.SENT) {
    throw new QuoteDecisionError(
      "Seul un devis envoyé et encore en attente peut être accepté ou refusé",
      "NOT_PENDING",
    );
  }

  const invoiced = await tx.invoice.count({
    where: {
      quoteId,
      documentType: InvoiceDocumentType.INVOICE,
      status: { not: InvoiceStatus.CANCELLED },
    },
  });
  if (invoiced > 0) {
    throw new QuoteDecisionError(
      "Ce devis a déjà donné lieu à une facture",
      "ALREADY_INVOICED",
    );
  }

  return quote;
}

/** Refuse un devis envoyé : le document est clos, aucune facture ne pourra en découler. */
export async function rejectQuote(quoteId: string, reason?: string) {
  return prisma.$transaction(async (tx) => {
    await loadPendingQuote(tx, quoteId);
    return tx.invoice.update({
      where: { id: quoteId },
      data: {
        quoteStatus: QuoteStatus.REJECTED,
        status: InvoiceStatus.CANCELLED,
        quoteDecidedAt: new Date(),
        quoteRejectReason: reason?.trim() || null,
      },
      include: { lines: true, client: true },
    });
  });
}

/**
 * Acceptation d'un devis par le client depuis le portail de suivi.
 * Le nom saisi vaut bon pour accord. La facture reste à émettre par le dirigeant.
 */
export async function acceptQuoteByClient(
  quoteId: string,
  signerName: string,
  audit: {
    source?: QuoteAcceptanceSource;
    threadId?: string | null;
    actor?: QuoteAcceptanceActor;
    context?: QuoteAcceptanceContext;
    signature?: QuoteSignature;
    /** Formule de paiement choisie (offre CHOICE : obligatoire depuis l'espace client). */
    paymentPlan?: PaymentPlan | null;
  } = {},
) {
  // Formule retenue, validée avant toute écriture.
  const pending = await prisma.invoice.findUniqueOrThrow({
    where: { id: quoteId },
    select: {
      paymentPlanOffer: true,
      totalCents: true,
      depositBaseCents: true,
      lines: { select: { isSubscription: true } },
    },
  });
  const offer = parsePaymentPlanOffer(pending.paymentPlanOffer);
  // Devis mixte : l'abonnement démarre à la livraison (projet terminé), pas à la signature.
  const deferSubscription = isDeferredSubscriptionQuote(pending);
  const plan =
    offer === null
      ? null
      : resolveAcceptedPlan(offer, audit.paymentPlan, { requireChoice: (audit.source ?? "PORTAL") === "PORTAL" });
  if (offer === null && audit.paymentPlan && audit.paymentPlan !== "TWO") {
    throw new PaymentPlanError("Cette formule de paiement n'est pas proposée sur ce devis.");
  }
  const settings = await getCompanySettings();
  const subscriptionOnly = offer === "NONE";

  // Signature portail : on fige le devis tel que le client l'a lu, avant qu'il porte l'accord.
  const { captureQuoteBeforeSignature, archiveOriginalQuote } = await import(
    "@/lib/invoices/acceptance-proof.js"
  );
  const original = audit.signature ? await captureQuoteBeforeSignature(quoteId) : null;

  const updated = await prisma.$transaction(async (tx) => {
    await loadPendingQuote(tx, quoteId);
    await ensureQuoteHasOfficialNumber(tx, quoteId);
    const result = await tx.invoice.update({
      where: { id: quoteId },
      data: {
        quoteStatus: QuoteStatus.ACCEPTED,
        quoteDecidedAt: new Date(),
        quoteSignerName: signerName.trim(),
        ...(plan ? { paymentPlan: plan } : {}),
      },
      include: { lines: true, client: true },
    });
    if (plan) await applyPlanMilestones(tx, quoteId, depositBaseOf(pending), plan, settings);
    // Abonnement seul : la 1re échéance est due tout de suite et facturée par l'abonnement
    // (Stripe après le mandat, sinon facture ERP immédiate), jamais par le devis.
    const subs = deferSubscription
      ? { subscriptionIds: [] as string[], createdIds: [] as string[] }
      : await activateSubscriptionsFromDocument(
          quoteId,
          tx,
          subscriptionOnly ? { firstPeriodNow: true, awaitStripe: settings.moduleStripeEnabled } : {},
        );
    return { result, subscriptionIds: subs.subscriptionIds, createdIds: subs.createdIds };
  });
  if (subscriptionOnly) await startSubscriptionBilling(updated.createdIds, settings.moduleStripeEnabled);
  else await notifyStripeSubscriptionSetup(updated.subscriptionIds);
  const accepted = updated.result;

  const acceptance = await logQuoteAcceptance(quoteId, signerName, audit.source ?? "PORTAL", {
    threadId: audit.threadId,
    actor: audit.actor,
    context: audit.context,
    signature: audit.signature,
    originalPdfSha256: original?.sha256 ?? null,
    paymentPlan: plan,
  });
  if (original) await archiveOriginalQuote(acceptance.id, original);

  const { onQuoteAcceptedByClient } = await import(
    "@/lib/payments/milestonePaymentService.js"
  );
  await onQuoteAcceptedByClient(quoteId);

  // Après l'échéancier : le PDF archivé porte les dates d'acompte.
  const { recordQuoteAcceptanceProof } = await import("@/lib/invoices/acceptance-proof.js");
  await recordQuoteAcceptanceProof(acceptance.id, quoteId);

  return accepted;
}

/**
 * Devis d'abonnement seul signé : Stripe actif, le lien de prélèvement part (une fois) et Stripe
 * prélève la 1re période au mandat ; sinon, la 1re facture d'abonnement est émise tout de suite.
 */
/** Devis mixte émis depuis la fonction : base figée, des lignes d'abonnement, pas abonnement seul. */
export function isDeferredSubscriptionQuote(quote: {
  depositBaseCents: number | null;
  paymentPlanOffer: string | null;
  lines: ReadonlyArray<{ isSubscription: boolean }>;
}): boolean {
  return quote.depositBaseCents !== null && quote.paymentPlanOffer !== "NONE" && quote.lines.some((l) => l.isSubscription);
}

/**
 * Devis mixte signé : démarre l'abonnement à la livraison (projet terminé) ou à la demande.
 * 1re échéance due tout de suite : lien de prélèvement Stripe (une fois) ou facture immédiate.
 * Idempotent : un abonnement déjà relié aux lignes du devis n'est pas recréé.
 * @returns les abonnements créés.
 */
export async function startDeferredSubscriptions(quoteId: string): Promise<string[]> {
  const quote = await prisma.invoice.findUnique({
    where: { id: quoteId },
    select: { documentType: true, quoteStatus: true, depositBaseCents: true, paymentPlanOffer: true, lines: true },
  });
  if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE || quote.quoteStatus !== QuoteStatus.ACCEPTED) return [];
  if (!isDeferredSubscriptionQuote(quote)) return [];
  if (quote.lines.filter((l) => l.isSubscription).every((l) => l.subscriptionId)) return [];
  const settings = await getCompanySettings();
  const subs = await prisma.$transaction((tx) =>
    activateSubscriptionsFromDocument(quoteId, tx, { firstPeriodNow: true, awaitStripe: settings.moduleStripeEnabled }),
  );
  await startSubscriptionBilling(subs.createdIds, settings.moduleStripeEnabled);
  return subs.createdIds;
}

async function startSubscriptionBilling(createdIds: string[], stripeEnabled: boolean): Promise<void> {
  if (createdIds.length === 0) return;
  if (stripeEnabled) {
    await notifyStripeSubscriptionSetup(createdIds);
    return;
  }
  const { invoiceSubscriptionNow } = await import("@/lib/subscriptions/subscription-service.js");
  for (const id of createdIds) {
    try {
      await invoiceSubscriptionNow(id);
    } catch (err) {
      // Le cron reprendra l'échéance (nextInvoiceAt est dépassé) : la signature reste acquise.
      console.error(`[abonnement] 1re facture à la signature : ${id}`, err);
    }
  }
}

/** Validation admin depuis la messagerie (fil lié à un client). */
export async function acceptQuoteFromThread(
  quoteId: string,
  opts: {
    signerName: string;
    threadId: string;
    actor: QuoteAcceptanceActor;
    paymentPlan?: PaymentPlan;
  },
) {
  const thread = await prisma.emailThread.findUnique({
    where: { id: opts.threadId },
    select: { clientId: true },
  });
  if (!thread?.clientId) {
    throw new QuoteDecisionError("Fil non rattaché à un client", "NOT_PENDING");
  }

  const quote = await prisma.invoice.findUnique({
    where: { id: quoteId },
    select: { clientId: true, documentType: true, quoteStatus: true },
  });
  if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new QuoteDecisionError("Ce document n'est pas un devis", "NOT_A_QUOTE");
  }
  if (quote.clientId !== thread.clientId) {
    throw new QuoteDecisionError("Ce devis n'appartient pas au client du fil", "NOT_PENDING");
  }

  return acceptQuoteByClient(quoteId, opts.signerName, {
    source: "THREAD",
    threadId: opts.threadId,
    actor: opts.actor,
    paymentPlan: opts.paymentPlan,
  });
}

/** Transforme un devis émis en brouillon de facture. */
export async function convertQuoteToInvoice(quoteId: string) {
  const invoice = await prisma.$transaction(async (tx) => {
    const quote = await tx.invoice.findUniqueOrThrow({
      where: { id: quoteId },
      include: { lines: { orderBy: { position: "asc" } } },
    });

    if (quote.documentType !== InvoiceDocumentType.QUOTE) {
      throw new Error("Seuls les devis peuvent être convertis");
    }
    if (quote.paymentPlanOffer === "NONE") {
      throw new Error(
        "Devis d'abonnement : chaque échéance est facturée par l'abonnement, pas de facture depuis le devis.",
      );
    }
    await assertQuoteSigned(quoteId, tx);
    if (
      quote.quoteStatus !== QuoteStatus.SENT &&
      quote.quoteStatus !== QuoteStatus.DRAFT &&
      quote.status !== InvoiceStatus.ISSUED &&
      quote.status !== InvoiceStatus.DRAFT
    ) {
      throw new Error("Devis non convertible");
    }

    const marketInvoices = await tx.invoice.count({
      where: {
        quoteId,
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: { in: [InvoiceType.ACOMPTE, InvoiceType.SOLDE] },
        status: { not: InvoiceStatus.CANCELLED },
      },
    });
    if (marketInvoices > 0) {
      throw new Error(
        "Ce devis a déjà un marché par acomptes : utilisez les factures d'acompte / solde",
      );
    }

    const existing = await tx.invoice.findFirst({
      where: {
        OR: [{ quoteId }, { sourceQuoteId: quoteId }],
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: { not: InvoiceStatus.CANCELLED },
      },
    });
    if (existing) {
      throw new Error("Ce devis a déjà été converti en facture");
    }

    // Devis mixte : la facture totale porte la partie ponctuelle ; l'abonnement sera facturé à
    // chaque période à partir de la livraison. Devis antérieur à la fonction : tout le devis.
    const deferred = isDeferredSubscriptionQuote(quote);
    const invoicedLines = deferred ? quote.lines.filter((l) => !l.isSubscription) : quote.lines;
    const oneOffSubtotal = invoicedLines.reduce((sum, l) => sum + l.lineTotalCents, 0);
    const invoiceTotal = deferred ? depositBaseOf(quote) : quote.totalCents;
    const created = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: quote.clientId,
        notes: quote.notes,
        paymentTerms: quote.paymentTerms ?? "Paiement à réception",
        subtotalCents: deferred ? oneOffSubtotal : quote.subtotalCents,
        totalCents: invoiceTotal,
        ...(deferred
          ? oneOffSubtotal > invoiceTotal
            ? { discountType: "FIXED", discountValue: oneOffSubtotal - invoiceTotal }
            : { discountType: "NONE", discountValue: 0 }
          : { discountType: quote.discountType, discountValue: quote.discountValue }),
        quoteId: quote.id,
        sourceQuoteId: quote.id,
        marketTotalCents: invoiceTotal,
        lines: {
          create: invoicedLines.map((line) => ({
            position: line.position,
            description: line.description,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            lineTotalCents: line.lineTotalCents,
            isSubscription: line.isSubscription,
            billingDay: line.billingDay,
            billingInterval: line.billingInterval,
            serviceId: line.serviceId,
            subscriptionId: line.subscriptionId,
          })),
        },
      },
      include: { lines: true, client: true },
    });

    await ensureQuoteHasOfficialNumber(tx, quote.id);
    await tx.invoice.update({
      where: { id: quote.id },
      data: {
        status: InvoiceStatus.PAID,
        quoteStatus: QuoteStatus.ACCEPTED,
        quoteDecidedAt: quote.quoteDecidedAt ?? new Date(),
      },
    });

    await ensureQuoteMilestones(quoteId, depositBaseOf(quote), tx);
    // Facture totale : les jalons d'acompte ne sont plus à payer. Sans cela, un lien de paiement
    // resté actif encaisserait un acompte qu'aucune facture ne pourrait plus porter.
    await tx.paymentMilestone.updateMany({
      where: {
        quoteId,
        invoiceId: null,
        status: { in: [MilestoneStatus.PENDING, MilestoneStatus.DUE, MilestoneStatus.OVERDUE, MilestoneStatus.FAILED] },
      },
      data: { status: MilestoneStatus.CANCELLED, checkoutUrl: null },
    });

    const subs = deferred
      ? { created: 0, subscriptionIds: [] as string[] }
      : await activateSubscriptionsFromDocument(quoteId, tx);

    // Propager subscriptionId des lignes devis → facture (même position)
    if (subs.subscriptionIds.length > 0) {
      const quoteLines = await tx.invoiceLine.findMany({
        where: { invoiceId: quoteId, isSubscription: true },
        orderBy: { position: "asc" },
      });
      const invLines = await tx.invoiceLine.findMany({
        where: { invoiceId: created.id, isSubscription: true },
        orderBy: { position: "asc" },
      });
      for (const qLine of quoteLines) {
        if (!qLine.subscriptionId) continue;
        const match = invLines.find((l) => l.position === qLine.position);
        if (match && !match.subscriptionId) {
          await tx.invoiceLine.update({
            where: { id: match.id },
            data: { subscriptionId: qLine.subscriptionId },
          });
        }
      }
    }

    return {
      ...created,
      subscriptionsCreated: subs.created,
      subscriptionIds: subs.subscriptionIds,
    };
  });

  await notifyStripeSubscriptionSetup(invoice.subscriptionIds ?? []);
  return invoice;
}
