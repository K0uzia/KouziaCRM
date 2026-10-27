import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { issuedDocumentPdf, issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";
import { paymentReceiptPdf } from "@/lib/pdf/receipt-archive.js";
import { loadDocumentForPdf } from "@/lib/pdf/document-pdf.js";
import { purgeRetention } from "@/lib/privacy/retention.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Demande du 27/10/2026 : PDF archivés de plus de 10 ans purgés par le worker, même règle que les preuves de signature
// (10 ans après la clôture de l'exercice : document de 2019 purgé à partir du 1er janvier 2030). La ligne comptable
// (numéro, montants, paiements) reste ; le PDF n'est ni réarchivé ni rendu à nouveau.
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin: vi.fn(async () => undefined) }));

const NOW = new Date(2030, 5, 1, 12);

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(() => {
  vi.useRealTimers();
});

async function archivedInvoice(number: string, issueDate: Date) {
  const client = await createClient({ displayName: "Client Ancien" });
  const inv = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.PAID, number, clientId: client.id,
      subtotalCents: 10_000, totalCents: 10_000, issueDate, issuedAt: issueDate,
      lines: { create: [{ position: 1, description: "Prestation", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 }] },
    },
  });
  const payment = await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 10_000, paidAt: issueDate, method: "BANK_TRANSFER" } });
  expect(await issuedDocumentPdf(inv.id)).not.toBeNull();
  expect(await paymentReceiptPdf(payment.id)).not.toBeNull();
  return { invoice: await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } }), payment: await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }) };
}

const exists = (rel: string) => fs.stat(issuedPdfAbsolutePath(rel)).then(() => true, () => false);

describe("PDF archivés de plus de 10 ans", () => {
  it("facture et reçu de 2019 purgés au 1er janvier 2030, ceux de 2020 gardés ; lignes comptables intactes", async () => {
    const old = await archivedInvoice("F-2019-0001", new Date(2019, 11, 31, 10));
    const kept = await archivedInvoice("F-2020-0001", new Date(2020, 0, 2, 10));

    const result = await purgeRetention(NOW);
    expect(result.documentPdfs).toBe(2);
    expect(await exists(old.invoice.pdfPath!)).toBe(false);
    expect(await exists(old.payment.receiptPdfPath!)).toBe(false);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: old.invoice.id } });
    expect([after.pdfPath, after.readableSnapshot, after.number, after.totalCents]).toEqual([null, null, "F-2019-0001", 10_000]);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: old.payment.id } })).receiptPdfPath).toBeNull();
    expect(await exists(kept.invoice.pdfPath!)).toBe(true);
    expect((await purgeRetention(NOW)).documentPdfs).toBe(0);
  });

  it("document purgé : ni réarchivé ni rendu à nouveau", async () => {
    const old = await archivedInvoice("F-2019-0002", new Date(2019, 5, 1, 10));
    await purgeRetention(NOW);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    expect(await issuedDocumentPdf(old.invoice.id)).toBeNull();
    expect(await loadDocumentForPdf(old.invoice.id)).toBeNull();
    expect(await paymentReceiptPdf(old.payment.id)).toBeNull();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: old.invoice.id } })).pdfPath).toBeNull();
  });
});
