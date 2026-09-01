import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  QuoteStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCompanySettings } from "@/lib/company";
import { allocateInvoiceNumber, allocateQuoteNumber } from "@/lib/invoices/numberingService";
import { ensureQuoteMilestones } from "@/lib/quotes/milestones";
import {
  buildClientSnapshot,
  type ClientSnapshot,
  generateMilestoneInvoice,
  generateBalanceInvoice,
  syncMilestoneOnInvoicePaid,
  assertQuoteEditable,
  DocumentFlowError,
} from "@/lib/invoices/documentFlowService";
import { activateSubscriptionsFromDocument } from "@/lib/subscriptions/activate-from-document";

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
} from "@/lib/invoices/credit-note-service";

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
  return prisma.$transaction((tx) =>
    issueInvoiceWithin(tx, invoiceId, issueDate, dueDate, settings),
  );
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
      },
      include: { lines: true, client: true, payments: true },
    });

    await ensureQuoteMilestones(quoteId, quote.totalCents, tx);
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

async function logQuoteAcceptance(
  quoteId: string,
  signerName: string,
  source: QuoteAcceptanceSource,
  opts: { threadId?: string | null; actor?: QuoteAcceptanceActor } = {},
) {
  await prisma.quoteAcceptanceAudit.create({
    data: {
      quoteId,
      signerName: signerName.trim(),
      source,
      threadId: opts.threadId ?? null,
      userId: opts.actor?.userId ?? null,
      userEmail: opts.actor?.userEmail ?? null,
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
  audit: { source?: QuoteAcceptanceSource; threadId?: string | null; actor?: QuoteAcceptanceActor } = {},
) {
  const updated = await prisma.$transaction(async (tx) => {
    await loadPendingQuote(tx, quoteId);
    await ensureQuoteHasOfficialNumber(tx, quoteId);
    const result = await tx.invoice.update({
      where: { id: quoteId },
      data: {
        quoteStatus: QuoteStatus.ACCEPTED,
        quoteDecidedAt: new Date(),
        quoteSignerName: signerName.trim(),
      },
      include: { lines: true, client: true },
    });
    await activateSubscriptionsFromDocument(quoteId, tx);
    return result;
  });

  await logQuoteAcceptance(quoteId, signerName, audit.source ?? "PORTAL", {
    threadId: audit.threadId,
    actor: audit.actor,
  });

  const { onQuoteAcceptedByClient } = await import(
    "@/lib/payments/milestonePaymentService.js"
  );
  await onQuoteAcceptedByClient(quoteId);

  return updated;
}

/** Validation admin depuis la messagerie (fil lié à un client). */
export async function acceptQuoteFromThread(
  quoteId: string,
  opts: {
    signerName: string;
    threadId: string;
    actor: QuoteAcceptanceActor;
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

    const created = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: quote.clientId,
        notes: quote.notes,
        paymentTerms: quote.paymentTerms ?? "Paiement à réception",
        subtotalCents: quote.subtotalCents,
        totalCents: quote.totalCents,
        discountType: quote.discountType,
        discountValue: quote.discountValue,
        quoteId: quote.id,
        sourceQuoteId: quote.id,
        marketTotalCents: quote.totalCents,
        lines: {
          create: quote.lines.map((line) => ({
            position: line.position,
            description: line.description,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            lineTotalCents: line.lineTotalCents,
            isSubscription: line.isSubscription,
            billingDay: line.billingDay,
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

    await ensureQuoteMilestones(quoteId, quote.totalCents, tx);

    const subs = await activateSubscriptionsFromDocument(quoteId, tx);

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

    return { ...created, subscriptionsCreated: subs.created };
  });

  return invoice;
}
