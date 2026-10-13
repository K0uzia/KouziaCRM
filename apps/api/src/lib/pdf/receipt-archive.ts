import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";
import { PaymentReceiptDocument, type PaymentReceiptPdfData } from "@/lib/pdf/payment-receipt-document.js";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";

/**
 * Reçu d'un règlement : rendu une fois, archivé (fichier + SHA-256) sous data/uploads/receipts, puis
 * servi tel quel (e-mail « Paiement reçu », /suivi). Même principe que les factures émises.
 */
const RECEIPTS_DIR = "receipts";

const METHOD_LABEL: Record<string, string> = {
  BANK_TRANSFER: "virement",
  CARD: "carte bancaire",
  SEPA_DEBIT: "prélèvement SEPA",
  CHECK: "chèque",
  CASH: "espèces",
  OTHER: "autre moyen",
};

const INVOICE_LABEL: Record<string, string> = { ACOMPTE: "Facture d'acompte", SOLDE: "Facture de solde" };

/** Nom de fichier du reçu, unique par règlement : deux règlements du même jour ne s'écrasent pas. */
export function receiptFileName(invoiceNumber: string, paidAt: Date, paymentId: string): string {
  const safe = invoiceNumber.replace(/[^A-Za-z0-9_-]/g, "_");
  return `Recu-${safe}-${paidAt.toISOString().slice(0, 10)}-${paymentId.slice(-6)}.pdf`;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Données du reçu : réglé à la date du règlement (ordre paidAt puis création), reste dû. */
export async function buildReceiptData(paymentId: string, now = new Date()): Promise<PaymentReceiptPdfData | null> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { invoice: { include: { client: true, payments: true } } },
  });
  const invoice = payment?.invoice;
  if (!payment || !invoice?.number) return null;

  const ordered = [...invoice.payments].sort(
    (a, b) => a.paidAt.getTime() - b.paidAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const upTo = ordered.slice(0, ordered.findIndex((p) => p.id === payment.id) + 1);
  const paidToDateCents = upTo.reduce((s, p) => s + p.amountCents, 0);
  const snapshot = invoice.clientSnapshot as ClientSnapshot | null;
  const company = await getCompanySettings();
  return {
    company: {
      legalName: company.legalName,
      tradeName: company.tradeName,
      siret: company.siret,
      addressLine1: company.addressLine1,
      postalCode: company.postalCode,
      city: company.city,
      email: company.email,
      vatMention: company.vatMention,
    },
    client: {
      displayName: snapshot?.displayName ?? invoice.client.displayName,
      addressLine1: snapshot?.addressLine1 ?? invoice.client.addressLine1,
      postalCode: snapshot?.postalCode ?? invoice.client.postalCode,
      city: snapshot?.city ?? invoice.client.city,
    },
    payment: {
      paidAt: payment.paidAt,
      amountCents: payment.amountCents,
      methodLabel: METHOD_LABEL[payment.method] ?? "autre moyen",
      reference: payment.reference,
    },
    invoice: {
      number: invoice.number,
      issueDate: invoice.issueDate,
      totalCents: invoice.totalCents,
      label: INVOICE_LABEL[invoice.invoiceType] ?? "Facture",
    },
    paidToDateCents,
    remainingCents: Math.max(0, invoice.totalCents - paidToDateCents),
    issuedAt: now,
  };
}

async function renderReceipt(data: PaymentReceiptPdfData): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Buffer.from(await renderToBuffer(React.createElement(PaymentReceiptDocument, data) as any));
}

/** PDF du reçu d'un règlement : archivé au premier appel, puis lu tel quel ; null sans facture numérotée. */
export async function paymentReceiptPdf(paymentId: string): Promise<Buffer | null> {
  const row = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, receiptPdfPath: true, receiptPdfSha256: true, invoice: { select: { number: true } } },
  });
  if (!row?.invoice?.number) return null;

  if (row.receiptPdfPath) {
    try {
      const pdf = await fs.readFile(issuedPdfAbsolutePath(row.receiptPdfPath));
      if (row.receiptPdfSha256 && sha256(pdf) !== row.receiptPdfSha256) {
        console.error(`[pdf] empreinte du reçu archivé différente (${row.receiptPdfPath})`);
      }
      return pdf;
    } catch (err) {
      // Archive perdue : rendu du moment sans la remplacer (restauration depuis la sauvegarde).
      console.error(`[pdf] reçu archivé illisible (${row.receiptPdfPath})`, err);
      const data = await buildReceiptData(paymentId);
      return data ? renderReceipt(data) : null;
    }
  }

  const data = await buildReceiptData(paymentId);
  if (!data) return null;
  const pdf = await renderReceipt(data);
  const digest = sha256(pdf);
  const safeNumber = row.invoice.number.replace(/[^A-Za-z0-9_-]/g, "_");
  const pdfPath = `${RECEIPTS_DIR}/${safeNumber}-${paymentId}-${digest.slice(0, 12)}-${randomBytes(3).toString("hex")}.pdf`;
  const abs = issuedPdfAbsolutePath(pdfPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, pdf, { flag: "wx" });
  const claimed = await prisma.payment.updateMany({
    where: { id: paymentId, receiptPdfPath: null },
    data: { receiptPdfPath: pdfPath, receiptPdfSha256: digest, receiptArchivedAt: new Date() },
  });
  if (claimed.count === 1) return pdf;
  // Accès simultané : l'autre archive est gardée.
  await fs.rm(abs, { force: true });
  return paymentReceiptPdf(paymentId);
}

/** Rattrapage (worker) : règlements de factures numérotées sans reçu archivé. */
export async function archivePendingReceipts(limit = 50): Promise<number> {
  const pending = await prisma.payment.findMany({
    where: { receiptPdfPath: null, invoice: { number: { not: null } } },
    select: { id: true },
    orderBy: { paidAt: "asc" },
    take: limit,
  });
  let archived = 0;
  for (const { id } of pending) {
    try {
      if (await paymentReceiptPdf(id)) archived += 1;
    } catch (err) {
      console.error(`[pdf] rattrapage du reçu impossible pour ${id}`, err);
    }
  }
  return archived;
}
