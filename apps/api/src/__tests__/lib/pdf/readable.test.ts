import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { loadDocumentForPdf, pdfDataOfLoaded } from "@/lib/pdf/document-pdf.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";
import { buildReceiptData } from "@/lib/pdf/receipt-archive.js";
import { readableInvoice, readableReceipt } from "@/lib/pdf/readable-documents.js";
import { pdfReadingText, sameTextAsPdf, type ReadableDocument } from "@/lib/pdf/readable.js";
import { PaymentReceiptDocument } from "@/lib/pdf/payment-receipt-document.js";
import { renderToBuffer } from "@react-pdf/renderer";
import React from "react";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

const ISSUE = new Date("2026-10-24T09:00:00Z");

type Line = { description: string; quantity?: number; unitPriceCents: number; isSubscription?: boolean; billingInterval?: string; commitmentMonths?: number };

async function issued(opts: {
  documentType?: "QUOTE" | "INVOICE" | "CREDIT_NOTE";
  invoiceType?: "SIMPLE" | "ACOMPTE" | "SOLDE";
  number: string;
  lines: Line[];
  discountPercentBps?: number;
  payments?: number[];
  clientType?: "B2B" | "B2C";
  notes?: string;
}) {
  const client = await createClient({ displayName: "Client Lecture", type: opts.clientType ?? "B2B" });
  const subtotal = opts.lines.reduce((s, l) => s + l.unitPriceCents * (l.quantity ?? 1), 0);
  const total = opts.discountPercentBps ? Math.round(subtotal * (1 - opts.discountPercentBps / 10_000)) : subtotal;
  return prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType: opts.documentType ?? "INVOICE",
      invoiceType: opts.invoiceType ?? "SIMPLE",
      number: opts.number,
      status: "ISSUED",
      issueDate: ISSUE,
      dueDate: opts.documentType === "QUOTE" ? null : new Date("2026-11-24T09:00:00Z"),
      ...(opts.documentType === "QUOTE" ? { quoteStatus: "SENT", validUntil: new Date("2026-11-24T09:00:00Z") } : {}),
      subtotalCents: subtotal,
      totalCents: total,
      notes: opts.notes ?? null,
      ...(opts.discountPercentBps ? { discountType: "PERCENT", discountValue: opts.discountPercentBps } : {}),
      lines: {
        create: opts.lines.map((l, i) => ({
          position: i,
          description: l.description,
          quantity: l.quantity ?? 1,
          unitPriceCents: l.unitPriceCents,
          lineTotalCents: l.unitPriceCents * (l.quantity ?? 1),
          isSubscription: l.isSubscription ?? false,
          billingInterval: l.billingInterval ?? null,
          commitmentMonths: l.commitmentMonths ?? null,
        })),
      },
      payments: opts.payments
        ? { create: opts.payments.map((amountCents, i) => ({ amountCents, paidAt: new Date(ISSUE.getTime() + (i + 1) * 86_400_000), method: "BANK_TRANSFER", reference: `VIR-${i + 1}` })) }
        : undefined,
    },
  });
}

/** PDF et version lisible d'un document : même texte, dans le même ordre. */
async function check(id: string): Promise<ReadableDocument> {
  const data = await pdfDataOfLoaded((await loadDocumentForPdf(id))!);
  const pdf = await renderInvoicePdf(data);
  const built = readableInvoice(data, "ARCHIVE");
  const text = await pdfReadingText(pdf);
  expect(sameTextAsPdf(text, built.atoms), `texte du PDF :\n${text}\n\natomes :\n${built.atoms.map((a) => a.text).join(" | ")}`).toBe(true);
  return built.doc;
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

describe("version lisible : même texte que le PDF", () => {
  it("facture avec remise et règlement partiel : structure complète", async () => {
    const inv = await issued({
      number: "F-2026-0101",
      lines: [
        { description: "Site vitrine", unitPriceCents: 120_000 },
        { description: "Rédaction des pages", quantity: 3, unitPriceCents: 15_000 },
      ],
      discountPercentBps: 1000,
      payments: [50_000],
      notes: "Merci pour votre confiance.",
    });
    const doc = await check(inv.id);
    expect(doc).toMatchObject({ version: 1, kind: "INVOICE", title: "Facture F-2026-0101", number: "F-2026-0101", source: "ARCHIVE" });
    expect(doc.issuer.name).toBe("Test");
    expect(doc.recipient).toEqual({ heading: "Facturé à", lines: expect.arrayContaining(["Client Lecture"]) });
    expect(doc.details).toContainEqual({ label: "Date d'émission", value: "24/10/2026" });
    expect(doc.table?.columns.map((c) => c.label)).toEqual(["Désignation", "Qté", "Prix unitaire", "Montant"]);
    expect(doc.table?.columns.map((c) => c.align)).toEqual(["start", "end", "end", "end"]);
    expect(doc.table?.rows[1]?.cells[0]).toBe("Rédaction des pages");
    expect(doc.table?.rows[1]?.cells[1]).toBe("3");
    expect(doc.totals.find((t) => t.main)?.label).toBe("Net à payer");
    expect(doc.totals.map((t) => t.label)).toEqual(expect.arrayContaining(["Sous-total", "Déjà réglé", "Reste dû"]));
    const payments = doc.sections.find((s) => s.heading === "Règlements reçus");
    expect(payments?.items[0]).toMatch(/^Date : 25\/10\/2026, Moyen : .+, Référence : VIR-1, Montant : 500,00/);
    expect(doc.sections.find((s) => s.heading === "Notes")?.paragraphs).toEqual(["Merci pour votre confiance."]);
    expect(doc.footer[0]).toContain("Facture F-2026-0101");
    // Aucun intitulé en capitales : un lecteur d'écran pourrait les épeler.
    const headings = [doc.recipient?.heading, ...doc.sections.map((s) => s.heading), ...(doc.table?.columns.map((c) => c.label) ?? [])];
    for (const h of headings.filter(Boolean)) expect(h).not.toMatch(/^[\p{Lu}\s']{4,}$/u);
  }, 30_000);

  it("facture réglée : « Facture acquittée » en casse normale", async () => {
    const inv = await issued({ number: "F-2026-0102", lines: [{ description: "Maintenance", unitPriceCents: 30_000 }], payments: [30_000] });
    const doc = await check(inv.id);
    expect(doc.sections.flatMap((s) => s.paragraphs)).toContain("Facture acquittée");
  }, 30_000);

  it("avoir, facture d'acompte et devis avec abonnement engagé", async () => {
    const credit = await issued({ documentType: "CREDIT_NOTE", number: "A-2026-0001", lines: [{ description: "Remboursement partiel", unitPriceCents: 10_000 }] });
    expect((await check(credit.id)).totals.find((t) => t.main)?.label).toBe("Montant de l'avoir");
    const deposit = await issued({ invoiceType: "ACOMPTE", number: "F-2026-0103", lines: [{ description: "Acompte de 30 %", unitPriceCents: 36_000 }] });
    expect((await check(deposit.id)).kind).toBe("DEPOSIT_INVOICE");
    const quote = await issued({
      documentType: "QUOTE",
      number: "D-2026-0101",
      clientType: "B2C",
      lines: [
        { description: "Site vitrine", unitPriceCents: 120_000 },
        { description: "Maintenance", unitPriceCents: 36_000, isSubscription: true, billingInterval: "YEAR", commitmentMonths: 12 },
      ],
    });
    const doc = await check(quote.id);
    expect(doc).toMatchObject({ kind: "QUOTE", title: "Devis D-2026-0101" });
    expect(doc.recipient?.heading).toBe("Destinataire");
    expect(doc.sections.some((s) => s.heading?.startsWith("Abonnement") || s.heading?.startsWith("Engagement"))).toBe(true);
  }, 60_000);

  it("document de plusieurs pages : en-tête du tableau et pied répétés retirés de la comparaison", async () => {
    const lines = Array.from({ length: 45 }, (_, i) => ({ description: `Prestation numéro ${i + 1}`, unitPriceCents: 1_000 + i }));
    const inv = await issued({ number: "F-2026-0104", lines });
    const data = await pdfDataOfLoaded((await loadDocumentForPdf(inv.id))!);
    const text = await pdfReadingText(await renderInvoicePdf(data));
    expect(text).toMatch(/Page 2 \/ \d/);
    expect(sameTextAsPdf(text, readableInvoice(data, "ARCHIVE").atoms)).toBe(true);
    expect(readableInvoice(data, "ARCHIVE").doc.table?.rows).toHaveLength(45);
  }, 30_000);

  it("un texte différent du PDF est détecté", async () => {
    const inv = await issued({ number: "F-2026-0105", lines: [{ description: "Site vitrine", unitPriceCents: 120_000 }] });
    const data = await pdfDataOfLoaded((await loadDocumentForPdf(inv.id))!);
    const pdf = await renderInvoicePdf(data);
    const changed = readableInvoice({ ...data, company: { ...data.company, city: "Brest" } }, "ARCHIVE");
    expect(sameTextAsPdf(await pdfReadingText(pdf), changed.atoms)).toBe(false);
  }, 30_000);

  it("reçu de paiement", async () => {
    const inv = await issued({ number: "F-2026-0106", lines: [{ description: "Site vitrine", unitPriceCents: 120_000 }], payments: [40_000] });
    const payment = await prisma.payment.findFirstOrThrow({ where: { invoiceId: inv.id } });
    const data = (await buildReceiptData(payment.id, ISSUE))!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdf = Buffer.from(await renderToBuffer(React.createElement(PaymentReceiptDocument, data) as any));
    const built = readableReceipt(data);
    const text = await pdfReadingText(pdf);
    expect(sameTextAsPdf(text, built.atoms), `${text}\n${built.atoms.map((a) => a.text).join(" | ")}`).toBe(true);
    expect(built.doc).toMatchObject({ kind: "PAYMENT_RECEIPT", title: "Reçu de paiement F-2026-0106", recipient: { heading: "Reçu de" } });
    expect(built.doc.sections.find((s) => s.heading === "Facture concernée")?.paragraphs).toContainEqual(expect.stringMatching(/^Reste dû : 800,00\s€$/));
  }, 30_000);
});
