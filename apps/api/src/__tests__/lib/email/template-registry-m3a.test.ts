import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, MilestoneStatus, PaymentMethod, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache, getCompanySettings } from "@/lib/company.js";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { templateDefinition } from "@/lib/email/template-registry.js";
import { formatEUR } from "@/lib/money.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Modèles M3a (paiements) : sans modification, l'e-mail est celui du code ; le modèle d'origine enregistré tel quel
// rend exactement le même objet et le même texte, au caractère près.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin: vi.fn(async () => undefined) }));

const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");
const { renderDepositCheckoutEmail, renderDepositPaidEmail, buildEmailBrand } = await import("@/lib/email/deposit-templates.js");
const { notifyInvoicePaymentFailed, notifyMilestonePaymentFailed } = await import("@/lib/stripe/payment-processing.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

async function original(key: string) {
  const def = templateDefinition(key)!;
  await prisma.emailTemplate.create({ data: { key, subject: def.subject, body: def.body } });
}

let seq = 0;
async function client(firstName: string | null = "Lou") {
  const c = await createClient({ displayName: "Lou Martin" });
  return prisma.client.update({ where: { id: c.id }, data: { firstName, emailEncrypted: encrypt("lou@example.com") } });
}

async function invoiceWithPayment(type: InvoiceType, totalCents: number, paidCents: number, withQuote: boolean) {
  const c = await client();
  seq += 1;
  const quote = withQuote
    ? await prisma.invoice.create({ data: { documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.ACCEPTED, number: `D-2026-09${seq}`, clientId: c.id, subtotalCents: totalCents, totalCents } })
    : null;
  const inv = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.INVOICE, invoiceType: type, status: InvoiceStatus.ISSUED, number: `F-2026-09${seq}`, clientId: c.id, subtotalCents: totalCents, totalCents, issueDate: new Date(), quoteId: quote?.id ?? null,
      lines: { create: [{ position: 1, description: "Prestation", quantity: 1, unitPriceCents: totalCents, lineTotalCents: totalCents }] },
    },
  });
  const payment = await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: paidCents, paidAt: new Date(), method: PaymentMethod.BANK_TRANSFER } });
  return { inv, payment };
}

async function receiptDraft(invoiceId: string, amountCents: number, paymentId?: string) {
  const r = await sendPaymentReceipt(invoiceId, amountCents, paymentId, { draft: true });
  return { subject: r.draft!.subject, text: r.draft!.text };
}

describe("M3a : reçu de paiement", () => {
  it.each([
    ["acompte soldé (démarrage du projet), devis cité", InvoiceType.ACOMPTE, 15_000, 15_000, true, true],
    ["facture simple réglée en partie", InvoiceType.SIMPLE, 20_000, 5_000, false, true],
    ["facture de solde soldée", InvoiceType.SOLDE, 35_000, 35_000, true, true],
    ["sans reçu (montant d'aucun règlement)", InvoiceType.SIMPLE, 20_000, 5_000, false, false],
  ])("%s : texte d'origine identique", async (_label, type, total, paid, withQuote, matching) => {
    const { inv, payment } = await invoiceWithPayment(type, total, paid, withQuote);
    const amount = matching ? paid : 1_234;
    const fromCode = await receiptDraft(inv.id, amount, matching ? payment.id : undefined);
    await original("payment.receipt");
    expect(await receiptDraft(inv.id, amount, matching ? payment.id : undefined)).toEqual(fromCode);
  });

  it("modèle modifié : appliqué, variables remplies, numéro remplacé", async () => {
    const { inv, payment } = await invoiceWithPayment(InvoiceType.SIMPLE, 20_000, 20_000, false);
    await prisma.emailTemplate.create({ data: { key: "payment.receipt", subject: "Merci : {{numero}} {{facture_reglee}}", body: "{{salutation}}\n\nReçu {{montant}}. {{etat_reglement}}" } });
    const d = await receiptDraft(inv.id, 20_000, payment.id);
    expect(d.subject).toBe(`Merci : ${inv.number} réglée`);
    expect(d.text.startsWith(`Bonjour Lou,\n\nReçu ${formatEUR(20_000)}. La facture est entièrement réglée.\n\n`)).toBe(true);
  });
});

describe("M3a : lien d'acompte et acompte reçu", () => {
  const base = async (extra: Partial<Parameters<typeof renderDepositCheckoutEmail>[0]> = {}) => {
    const settings = await getCompanySettings();
    return { brand: buildEmailBrand(settings), settings, brandPrimaryColor: "#fe9a00", clientFirstName: "Lou", clientName: "Lou Martin", quoteNumber: "D-2026-0012", amountCents: 45_000, checkoutUrl: "https://pay.test/a", depositIndex: 1, depositTotal: 2, label: "Acompte", ...extra };
  };

  it.each([
    ["acompte", {}],
    ["solde (dernier rang)", { depositIndex: 2, label: "Solde" }],
    ["sans prénom", { clientFirstName: null }],
  ])("lien %s : texte d'origine identique (objet, texte, HTML)", async (_l, extra) => {
    const opts = await base(extra as never);
    const fromCode = await renderDepositCheckoutEmail(opts);
    await original("payment.deposit_link");
    expect(await renderDepositCheckoutEmail(opts)).toEqual(fromCode);
  });

  it.each([["Acompte"], ["Solde"]])("acompte reçu (%s) : texte d'origine identique", async (label) => {
    const opts = await base({ label });
    const fromCode = await renderDepositPaidEmail(opts);
    await original("payment.deposit_paid");
    expect(await renderDepositPaidEmail(opts)).toEqual(fromCode);
  });
});

describe("M3a : paiement non abouti", () => {
  const outbox = async () => {
    const rows = await prisma.emailOutbox.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map((r) => {
      const p = parsePayload(outboxPayloadRaw(r));
      return { subject: p.subject, text: p.text };
    });
  };

  it.each([
    ["avec lien et IBAN", "https://pay.test/f", "FR7612345678901234567890123"],
    ["sans lien ni IBAN", null, null],
  ])("facture %s : texte d'origine identique", async (_l, checkoutUrl, iban) => {
    await prisma.companySettings.updateMany({ data: { bankIban: iban } });
    invalidateCompanySettingsCache();
    const c = await client();
    const inv = await prisma.invoice.create({
      data: { documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: "F-2026-0950", clientId: c.id, subtotalCents: 9_000, totalCents: 9_000, checkoutUrl, paymentProcessingAt: new Date() },
    });
    const pi = { id: "pi_x", amount: 9_000, metadata: { erpInvoiceId: inv.id }, payment_method_types: ["sepa_debit"], last_payment_error: { message: "Refusé" } } as unknown as Stripe.PaymentIntent;
    await notifyInvoicePaymentFailed(pi);
    await original("payment.failed");
    await prisma.invoice.update({ where: { id: inv.id }, data: { paymentProcessingAt: new Date() } });
    await notifyInvoicePaymentFailed(pi);
    const [fromCode, fromTemplate] = await outbox();
    expect(fromTemplate).toEqual(fromCode);
  });

  it("échéance de devis : texte d'origine identique", async () => {
    await prisma.companySettings.updateMany({ data: { bankIban: "FR7612345678901234567890123" } });
    invalidateCompanySettingsCache();
    const c = await client(null);
    const quote = await prisma.invoice.create({ data: { documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.ACCEPTED, number: "D-2026-0951", clientId: c.id, subtotalCents: 10_000, totalCents: 10_000 } });
    const ms = await prisma.paymentMilestone.create({ data: { quoteId: quote.id, position: 1, label: "Acompte", percentBps: 3000, amountCents: 3_000, triggerText: "Signature", status: MilestoneStatus.DUE, checkoutUrl: "https://pay.test/m" } });
    const pi = { id: "pi_m", amount: 3_000, metadata: { erpMilestoneId: ms.id } } as unknown as Stripe.PaymentIntent;
    await notifyMilestonePaymentFailed(pi, true);
    await original("payment.failed");
    await notifyMilestonePaymentFailed(pi, true);
    const [fromCode, fromTemplate] = await outbox();
    expect(fromCode!.subject).toBe("Paiement non abouti : devis D-2026-0951");
    expect(fromTemplate).toEqual(fromCode);
  });
});
