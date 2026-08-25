import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  QuoteStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCompanySettings } from "@/lib/company";
import { allocateInvoiceNumber, allocateQuoteNumber, allocateCreditNoteNumber } from "@/lib/invoices/numberingService";
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

export type { ClientSnapshot };
export {
  generateMilestoneInvoice,
  generateBalanceInvoice,
  syncMilestoneOnInvoicePaid,
  assertQuoteEditable,
  DocumentFlowError,
};

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

export async function issueInvoice(invoiceId: string, issueDate = new Date(), dueDate?: Date) {
  const settings = await getCompanySettings();
  return prisma.$transaction(async (tx) => {
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

    return tx.invoice.update({
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
  });
}

/** Émet un devis (numéro D-YYYY-NNN, QuoteStatus SENT) et crée les jalons 30/40/30. */
export async function issueQuote(
  quoteId: string,
  issueDate = new Date(),
  validUntil?: Date,
) {
  const settings = await getCompanySettings();
  return prisma.$transaction(async (tx) => {
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
}

/** Transforme un devis émis en brouillon de facture. */
export async function convertQuoteToInvoice(quoteId: string) {
  return prisma.$transaction(async (tx) => {
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

    const invoice = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: quote.clientId,
        notes: quote.notes,
        paymentTerms: quote.paymentTerms ?? "Paiement à réception",
        subtotalCents: quote.subtotalCents,
        totalCents: quote.totalCents,
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
          })),
        },
      },
      include: { lines: true, client: true },
    });

    await tx.invoice.update({
      where: { id: quote.id },
      data: {
        status: InvoiceStatus.PAID,
        quoteStatus: QuoteStatus.ACCEPTED,
      },
    });

    await ensureQuoteMilestones(quoteId, quote.totalCents, tx);

    return invoice;
  });
}

/** Annule une facture émise via un avoir (série AVOIR distincte). */
export async function cancelInvoiceWithCreditNote(invoiceId: string, issueDate = new Date()) {
  return prisma.$transaction(async (tx) => {
    const original = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: { lines: { orderBy: { position: "asc" } }, creditNotes: true },
    });

    if (original.status !== InvoiceStatus.ISSUED && original.status !== InvoiceStatus.PAID) {
      throw new Error("Seules les factures émises ou payées peuvent être annulées par avoir");
    }
    if (original.documentType !== InvoiceDocumentType.INVOICE) {
      throw new Error("Impossible d'annuler un avoir");
    }
    if (original.creditNotes.length > 0) {
      throw new Error("Un avoir existe déjà pour cette facture");
    }

    const settings = await getCompanySettings();
    const allocated = await allocateCreditNoteNumber(issueDate, tx, settings);
    const snapshot =
      (original.clientSnapshot as ClientSnapshot | null) ??
      (await buildClientSnapshot(original.clientId, tx));

    const creditNote = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.CREDIT_NOTE,
        status: InvoiceStatus.ISSUED,
        clientId: original.clientId,
        clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        number: allocated.number,
        sequenceYear: allocated.sequenceYear,
        sequenceNumber: allocated.sequenceNumber,
        issueDate,
        dueDate: issueDate,
        issuedAt: new Date(),
        currency: original.currency,
        subtotalCents: -Math.abs(original.subtotalCents),
        totalCents: -Math.abs(original.totalCents),
        notes: `Avoir sur facture ${original.number}`,
        paymentTerms: original.paymentTerms,
        creditedInvoiceId: original.id,
        lines: {
          create: original.lines.map((line) => ({
            position: line.position,
            description: line.description,
            quantity: line.quantity,
            unitPriceCents: -Math.abs(line.unitPriceCents),
            lineTotalCents: -Math.abs(line.lineTotalCents),
          })),
        },
      },
      include: { lines: true },
    });

    await tx.invoice.update({
      where: { id: original.id },
      data: { status: InvoiceStatus.CANCELLED },
    });

    return creditNote;
  });
}
