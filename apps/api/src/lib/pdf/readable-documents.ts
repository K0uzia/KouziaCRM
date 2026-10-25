import type { ReactElement } from "react";
import fs from "node:fs/promises";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { InvoiceDocument, type InvoicePdfData } from "@/lib/pdf/invoice-document.js";
import { PaymentReceiptDocument, type PaymentReceiptPdfData } from "@/lib/pdf/payment-receipt-document.js";
import {
  pdfReadingText,
  readableFromElement,
  sameTextAsPdf,
  type ReadableAtom,
  type ReadableDocument,
  type ReadableKind,
} from "@/lib/pdf/readable.js";

/**
 * Version lisible des documents (contrat B avec le site, RGAA 13.3). Factures, avoirs et reçus : JSON figé avec le
 * PDF archivé, seulement si son texte est exactement celui du PDF ; sinon marqué indisponible (lien masqué dans /suivi).
 * Devis : rendu à la demande, comme son PDF.
 */

type Built = { doc: ReadableDocument; atoms: ReadableAtom[] };

const CAPTION: Record<ReadableKind, string> = {
  QUOTE: "Détail du devis",
  INVOICE: "Détail de la facture",
  DEPOSIT_INVOICE: "Détail de la facture d'acompte",
  BALANCE_INVOICE: "Détail de la facture de solde",
  CREDIT_NOTE: "Détail de l'avoir",
  PAYMENT_RECEIPT: "Détail du reçu",
};

export function readableInvoice(data: InvoicePdfData, source: "ARCHIVE" | "LIVE"): Built {
  const inv = data.invoice;
  const kind: ReadableKind =
    inv.documentType === "QUOTE"
      ? "QUOTE"
      : inv.documentType === "CREDIT_NOTE"
        ? "CREDIT_NOTE"
        : inv.invoiceType === "ACOMPTE"
          ? "DEPOSIT_INVOICE"
          : inv.invoiceType === "SOLDE"
            ? "BALANCE_INVOICE"
            : "INVOICE";
  return readableFromElement(InvoiceDocument(data) as ReactElement, { kind, number: inv.number, caption: CAPTION[kind], source });
}

export function readableReceipt(data: PaymentReceiptPdfData): Built {
  return readableFromElement(PaymentReceiptDocument(data) as ReactElement, {
    kind: "PAYMENT_RECEIPT",
    number: data.invoice.number,
    caption: CAPTION.PAYMENT_RECEIPT,
    source: "ARCHIVE",
  });
}

/** Instantané à enregistrer : le JSON si le texte du PDF est exactement le sien, sinon le marqueur d'indisponibilité. */
export async function snapshotFor(pdf: Buffer, built: Built): Promise<{ snapshot: string; ok: boolean }> {
  const ok = sameTextAsPdf(await pdfReadingText(pdf), built.atoms);
  return { snapshot: JSON.stringify(ok ? built.doc : { unavailable: "text-mismatch" }), ok };
}

/** JSON lisible d'un instantané ; null si absent, indisponible ou illisible. */
export function parseReadable(snapshot: string | null | undefined): ReadableDocument | null {
  if (!snapshot) return null;
  try {
    const parsed = JSON.parse(snapshot) as ReadableDocument;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Disponible sans tout analyser (liste /suivi) : seul un instantané valide commence ainsi. */
export const readableAvailable = (snapshot: string | null | undefined) => Boolean(snapshot?.startsWith('{"version":1'));

/**
 * Lien « version lisible » annoncé dans /suivi seulement s'il peut être servi : devis non signé rendu à la demande ;
 * devis signé, facture ou avoir avec une version figée valable (figée à la signature ou à l'archivage, rattrapée sinon).
 */
export function readableLinkAvailable(d: { number: string | null; documentType: string; quoteStatus: string | null; readableSnapshot: string | null }): boolean {
  if (!d.number) return false;
  if (d.documentType === InvoiceDocumentType.QUOTE && d.quoteStatus !== "ACCEPTED") return true;
  return readableAvailable(d.readableSnapshot);
}

/** Une alerte par rattrapage, listant les documents dont le texte ne correspond pas : chacun n'est signalé qu'une fois. */
export async function alertMismatch(labels: string[]): Promise<void> {
  if (!labels.length) return;
  try {
    const { alertAdmin } = await import("@/lib/stripe/alert.js");
    await alertAdmin(
      "Version accessible indisponible pour des documents archivés",
      `Le texte reconstruit ne correspond pas exactement au PDF archivé pour : ${labels.join(", ")}. Leur version accessible reste masquée dans l'espace client ; le PDF archivé est inchangé.`,
    );
  } catch (err) {
    console.error("[pdf] alerte de version lisible impossible", err);
  }
}

/**
 * Rattrapage (worker) des factures, avoirs et reçus archivés avant la version lisible : reconstruits tels qu'à leur
 * archivage (règlements et avoirs enregistrés ensuite exclus), figés seulement si le texte est celui du PDF archivé.
 */
export async function backfillReadableSnapshots(limit = 50): Promise<{ frozen: number; unavailable: number }> {
  const { issuedPdfAbsolutePath } = await import("@/lib/pdf/issued-archive.js");
  const { loadDocumentForPdf, pdfDataOfLoaded } = await import("@/lib/pdf/document-pdf.js");
  const { buildReceiptData } = await import("@/lib/pdf/receipt-archive.js");
  let frozen = 0;
  const mismatched: string[] = [];

  const invoices = await prisma.invoice.findMany({
    where: {
      documentType: { in: [InvoiceDocumentType.INVOICE, InvoiceDocumentType.CREDIT_NOTE] },
      status: { not: InvoiceStatus.DRAFT },
      number: { not: null },
      pdfPath: { not: null },
      readableSnapshot: null,
    },
    select: { id: true, number: true, pdfPath: true, pdfArchivedAt: true },
    orderBy: { issuedAt: "asc" },
    take: limit,
  });
  for (const row of invoices) {
    try {
      const pdf = await fs.readFile(issuedPdfAbsolutePath(row.pdfPath!));
      const loaded = await loadDocumentForPdf(row.id);
      if (!loaded) continue;
      const at = row.pdfArchivedAt ?? new Date();
      const asArchived = {
        ...loaded,
        invoice: {
          ...loaded.invoice,
          payments: loaded.invoice.payments.filter((p) => p.createdAt <= at),
          creditNotes: loaded.invoice.creditNotes
            .filter((c) => c.createdAt <= at)
            .map((c) => ({ ...c, payments: c.payments.filter((p) => p.createdAt <= at) })),
        },
      };
      const { snapshot, ok } = await snapshotFor(pdf, readableInvoice(await pdfDataOfLoaded(asArchived), "ARCHIVE"));
      await prisma.invoice.updateMany({ where: { id: row.id, readableSnapshot: null }, data: { readableSnapshot: snapshot } });
      if (ok) frozen += 1;
      else mismatched.push(row.number!);
    } catch (err) {
      // Archive illisible : déjà signalée par la lecture du PDF ; on réessaiera au prochain passage.
      console.error(`[pdf] version lisible non rattrapée pour ${row.number}`, err);
    }
  }

  const signedQuotes = await prisma.invoice.findMany({
    where: { documentType: InvoiceDocumentType.QUOTE, quoteStatus: "ACCEPTED", number: { not: null }, readableSnapshot: null, quoteAcceptanceAudits: { some: { pdfPath: { not: null } } } },
    select: { id: true, number: true, quoteAcceptanceAudits: { where: { pdfPath: { not: null } }, orderBy: { createdAt: "desc" }, take: 1, select: { pdfPath: true } } },
    take: limit,
  });
  if (signedQuotes.length) {
    const { signedQuoteAbsolutePath } = await import("@/lib/invoices/acceptance-proof.js");
    for (const row of signedQuotes) {
      try {
        const pdf = await fs.readFile(signedQuoteAbsolutePath(row.quoteAcceptanceAudits[0]!.pdfPath!));
        const loaded = await loadDocumentForPdf(row.id);
        if (!loaded) continue;
        const { snapshot, ok } = await snapshotFor(pdf, readableInvoice(await pdfDataOfLoaded(loaded), "ARCHIVE"));
        await prisma.invoice.updateMany({ where: { id: row.id, readableSnapshot: null }, data: { readableSnapshot: snapshot } });
        if (ok) frozen += 1;
        else mismatched.push(row.number!);
      } catch (err) {
        console.error(`[pdf] version lisible du devis signé non rattrapée pour ${row.number}`, err);
      }
    }
  }

  const receipts = await prisma.payment.findMany({
    where: { receiptPdfPath: { not: null }, receiptReadableSnapshot: null },
    select: { id: true, receiptPdfPath: true, receiptArchivedAt: true, invoice: { select: { number: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  for (const row of receipts) {
    try {
      const pdf = await fs.readFile(issuedPdfAbsolutePath(row.receiptPdfPath!));
      const data = await buildReceiptData(row.id, row.receiptArchivedAt ?? new Date());
      if (!data) continue;
      const { snapshot, ok } = await snapshotFor(pdf, readableReceipt(data));
      await prisma.payment.updateMany({ where: { id: row.id, receiptReadableSnapshot: null }, data: { receiptReadableSnapshot: snapshot } });
      if (ok) frozen += 1;
      else mismatched.push(`reçu de ${row.invoice?.number ?? "?"}`);
    } catch (err) {
      console.error(`[pdf] version lisible du reçu non rattrapée (${row.id})`, err);
    }
  }

  await alertMismatch(mismatched);
  return { frozen, unavailable: mismatched.length };
}


