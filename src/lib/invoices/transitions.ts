import { InvoiceDocumentType, InvoiceStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptOptional } from "@/lib/crypto";
import { allocateInvoiceNumber } from "@/lib/invoices/numbering";

export type ClientSnapshot = {
  displayName: string;
  type: string;
  email: string | null;
  phone: string | null;
  siret: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
};

async function buildClientSnapshot(
  clientId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ClientSnapshot> {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  return {
    displayName: client.displayName,
    type: client.type,
    email: decryptOptional(client.emailEncrypted),
    phone: decryptOptional(client.phoneEncrypted),
    siret: decryptOptional(client.siretEncrypted),
    addressLine1: client.addressLine1,
    addressLine2: client.addressLine2,
    postalCode: client.postalCode,
    city: client.city,
    country: client.country,
  };
}

export async function issueInvoice(invoiceId: string, issueDate = new Date(), dueDate?: Date) {
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
      throw new Error("Document invalide pour émission");
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
      },
      include: { lines: true, client: true, payments: true },
    });
  });
}

/** Annule une facture émise via un avoir (même série de numéros). */
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

    const allocated = await allocateInvoiceNumber(issueDate, tx);
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
