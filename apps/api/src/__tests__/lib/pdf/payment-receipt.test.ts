import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { formatEUR } from "@/lib/money.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import { pdfText } from "../../helpers/pdf-text.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));

const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { issueInvoice } = await import("@/lib/invoices/transitions.js");
const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
const { paymentReceiptPdf, archivePendingReceipts } = await import("@/lib/pdf/receipt-archive.js");
const { signReceiptToken, signDocumentToken, verifyReceiptToken, verifyDocumentToken } = await import(
  "@/lib/documents/public-token.js"
);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  vi.mocked(mailEnqueue).mockClear();
});
afterEach(async () => {
  await resetDb();
});

async function issuedInvoice(totalCents = 100_000) {
  const client = await createClient({ type: "B2C", displayName: "Lou Martin" });
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt("lou@example.test") } });
  const draft = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: totalCents,
      totalCents,
      lines: { create: { position: 1, description: "Site vitrine", quantity: 1, unitPriceCents: totalCents, lineTotalCents: totalCents } },
    },
  });
  await issueInvoice(draft.id, new Date(2026, 9, 1));
  return prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
}

const pay = (invoiceId: string, amountCents: number, day: number) =>
  prisma.payment.create({
    data: { invoiceId, amountCents, paidAt: new Date(2026, 9, day), method: PaymentMethod.BANK_TRANSFER, reference: `VIR-${day}` },
  });

function lastMail() {
  const m = vi.mocked(mailEnqueue).mock.calls.at(-1)![0];
  const attachments = (m.attachments ?? []).map((a) => ({ name: a.filename, pdf: Buffer.from(a.contentBase64, "base64") }));
  return { text: m.text, subject: m.subject, attachments };
}

describe("e-mail « Paiement reçu » : le texte correspond aux pièces jointes réelles", () => {
  it("acompte partiel : reçu (reste dû) + facture telle qu'émise, sans rien prétendre d'autre", async () => {
    const invoice = await issuedInvoice();
    const p = await pay(invoice.id, 40_000, 5);
    await sendPaymentReceipt(invoice.id, 40_000);
    const { text, subject, attachments } = lastMail();

    expect(subject).toBe(`Paiement reçu : facture ${invoice.number}`);
    expect(text).toContain(`Il reste ${formatEUR(60_000)} à régler.`);
    expect(text).toContain(`Vous trouverez ci-joint le reçu de ce paiement et la facture ${invoice.number}.`);
    expect(text).not.toMatch(/acquitt|marquée|à jour/i);

    expect(attachments).toHaveLength(2);
    const [facture, recu] = attachments;
    // Facture : exactement le PDF archivé à l'émission, sans mention de règlement.
    expect(sha(facture!.pdf)).toBe(invoice.pdfSha256);
    expect(pdfText(facture!.pdf)).not.toContain("ACQUITT");
    // Reçu : le PDF archivé de ce règlement, avec le montant, le reste dû et sans « acquittée ».
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(sha(recu!.pdf)).toBe(row.receiptPdfSha256);
    expect(recu!.name).toBe(`Recu-${invoice.number}-${p.paidAt.toISOString().slice(0, 10)}-${p.id.slice(-6)}.pdf`);
    const recuText = pdfText(recu!.pdf);
    expect(recuText).toContain("Reçu de paiement");
    expect(recuText).toContain("400,00");
    expect(recuText).toContain("600,00");
    // Reçu partiel : la facture est « concernée », jamais « réglée » ni « acquittée ».
    expect(recuText).toContain("FACTURE CONCERNÉE");
    expect(recuText).not.toContain("RÉGLÉE");
    expect(recuText).not.toMatch(/acquitt/i);
  });

  it("solde : « entièrement réglée » dans l'e-mail, « FACTURE ACQUITTÉE » sur le reçu (et seulement là)", async () => {
    const invoice = await issuedInvoice();
    await pay(invoice.id, 40_000, 5);
    await pay(invoice.id, 60_000, 20);
    await sendPaymentReceipt(invoice.id, 60_000);
    const { text, subject, attachments } = lastMail();
    expect(subject).toBe(`Paiement reçu : facture ${invoice.number} réglée`);
    expect(text).toContain("La facture est entièrement réglée.");
    expect(text).toContain("le reçu de ce paiement et la facture");
    const [facture, recu] = attachments;
    expect(pdfText(facture!.pdf)).not.toContain("ACQUITT");
    expect(pdfText(recu!.pdf)).toContain("ACQUITT");
  });

  it("deux règlements du même jour : deux reçus au nom de fichier distinct", async () => {
    const invoice = await issuedInvoice();
    await pay(invoice.id, 40_000, 5);
    await sendPaymentReceipt(invoice.id, 40_000);
    const first = lastMail().attachments[1]!.name;
    await pay(invoice.id, 60_000, 5);
    await sendPaymentReceipt(invoice.id, 60_000);
    const second = lastMail().attachments[1]!.name;
    expect(first).toMatch(/^Recu-.*\.pdf$/);
    expect(second).not.toBe(first);
  });

  it("reçu archivé une fois : relu tel quel, même après un autre règlement ; rattrapage idempotent", async () => {
    const invoice = await issuedInvoice();
    const first = await pay(invoice.id, 40_000, 5);
    const a = await paymentReceiptPdf(first.id);
    await pay(invoice.id, 60_000, 20);
    const b = await paymentReceiptPdf(first.id);
    expect(sha(b!)).toBe(sha(a!));
    expect(pdfText(b!)).not.toContain("ACQUITT");
    expect(await archivePendingReceipts()).toBe(1);
    expect(await archivePendingReceipts()).toBe(0);
  });
});

describe("jeton du reçu", () => {
  it("un jeton de reçu ne vaut pas jeton de document, et inversement", () => {
    const receipt = signReceiptToken("pay_1");
    expect(verifyReceiptToken(receipt)).toBe("pay_1");
    expect(verifyDocumentToken(receipt)).not.toBe("pay_1");
    expect(verifyReceiptToken(signDocumentToken("inv_1"))).toBeNull();
  });
});
