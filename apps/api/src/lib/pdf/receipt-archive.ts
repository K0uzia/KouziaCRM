import { invoiceBalance } from "@/lib/invoices/balance.js";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { prisma } from "@/lib/prisma.js";
import { parisIsoDate } from "@/lib/format-fr.js";
import { getCompanySettings } from "@/lib/company.js";
import { alertArchivedFile, issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";
import { loadBrandLogoDataUrl } from "@/lib/pdf/brand-assets.js";
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
  return `Recu-${safe}-${parisIsoDate(paidAt)}-${paymentId.slice(-6)}.pdf`;
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Données du reçu : réglé à la date du règlement (ordre paidAt puis création), reste dû. */
export async function buildReceiptData(paymentId: string, now = new Date()): Promise<PaymentReceiptPdfData | null> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      invoice: {
        include: {
          client: true,
          payments: true,
          creditNotes: { select: { totalCents: true, createdAt: true, payments: { select: { amountCents: true, createdAt: true } } } },
        },
      },
    },
  });
  const invoice = payment?.invoice;
  if (!payment || !invoice?.number) return null;

  const ordered = [...invoice.payments].sort(
    (a, b) => a.paidAt.getTime() - b.paidAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const upTo = ordered.slice(0, ordered.findIndex((p) => p.id === payment.id) + 1);
  // Solde à la date du reçu : avoirs et remboursements enregistrés avant ce paiement (le reçu archivé ne change plus).
  const at = payment.createdAt.getTime();
  const before = invoice.creditNotes
    .filter((cn) => cn.createdAt.getTime() <= at)
    .map((cn) => ({ totalCents: cn.totalCents, payments: cn.payments.filter((p) => p.createdAt.getTime() <= at) }));
  const balance = invoiceBalance({ totalCents: invoice.totalCents, payments: upTo, creditNotes: before });
  const paidToDateCents = balance.cashInCents;
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
      brandPrimaryColor: company.brandPrimaryColor,
      brandSecondaryColor: company.brandSecondaryColor,
      brandLogoDataUrl: await loadBrandLogoDataUrl(company.brandLogoPath),
      pdfFooterText: company.pdfFooterText,
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
    remainingCents: balance.dueCents,
    ...(balance.creditedCents > 0 ? { creditedCents: balance.creditedCents } : {}),
    issuedAt: now,
  };
}

async function renderReceipt(data: PaymentReceiptPdfData): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Buffer.from(await renderToBuffer(React.createElement(PaymentReceiptDocument, data) as any));
}

const receiptFile = (row: { id: string; receiptPdfPath: string | null; invoice: { number: string | null } | null }) => ({
  id: `receipt:${row.id}`,
  label: `reçu du règlement de ${row.invoice?.number ?? "?"}`,
  path: row.receiptPdfPath ?? "",
});

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
        // Jamais de réécriture silencieuse : l'écart est signalé, le fichier archivé reste servi.
        console.error(`[pdf] empreinte du reçu archivé différente (${row.receiptPdfPath})`);
        await alertArchivedFile(receiptFile(row), "son empreinte SHA-256 ne correspond plus au fichier");
      }
      return pdf;
    } catch (err) {
      // Archive perdue : rendu du moment sans la remplacer (restauration depuis la sauvegarde).
      console.error(`[pdf] reçu archivé illisible (${row.receiptPdfPath})`, err);
      await alertArchivedFile(receiptFile(row), "le fichier archivé est introuvable ou illisible");
      const data = await buildReceiptData(paymentId);
      return data ? renderReceipt(data) : null;
    }
  }

  const data = await buildReceiptData(paymentId);
  if (!data) return null;
  const pdf = await renderReceipt(data);
  const { alertMismatch, readableReceipt, snapshotFor } = await import("@/lib/pdf/readable-documents.js");
  const readable = await snapshotFor(pdf, readableReceipt(data));
  const digest = sha256(pdf);
  const safeNumber = row.invoice.number.replace(/[^A-Za-z0-9_-]/g, "_");
  const pdfPath = `${RECEIPTS_DIR}/${safeNumber}-${paymentId}-${digest.slice(0, 12)}-${randomBytes(3).toString("hex")}.pdf`;
  const abs = issuedPdfAbsolutePath(pdfPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, pdf, { flag: "wx" });
  const claimed = await prisma.payment.updateMany({
    where: { id: paymentId, receiptPdfPath: null },
    data: { receiptPdfPath: pdfPath, receiptPdfSha256: digest, receiptArchivedAt: new Date(), receiptReadableSnapshot: readable.snapshot },
  });
  if (claimed.count === 1) {
    if (!readable.ok) await alertMismatch([`reçu de ${row.invoice.number}`]);
    return pdf;
  }
  // Accès simultané : l'autre archive est gardée.
  await fs.rm(abs, { force: true });
  return paymentReceiptPdf(paymentId);
}

/** Rattrapage (worker) : règlements de factures numérotées sans reçu archivé. */
export async function archivePendingReceipts(limit = 50): Promise<number> {
  const pending = await prisma.payment.findMany({
    where: { receiptPdfPath: null, amountCents: { gt: 0 }, invoice: { number: { not: null } } },
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
