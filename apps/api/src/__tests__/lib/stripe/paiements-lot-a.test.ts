import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, MilestoneStatus, PaymentMethod, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Lot A (audit des paiements du 25/10/2026) : chaque test reproduit un défaut relevé avant sa correction.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: async () => true,
}));

const { alertAdmin } = vi.hoisted(() => ({ alertAdmin: vi.fn(async (_subject: string, _text: string) => undefined) }));
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));

const { buildApp } = await import("@/app.js");
const { markPaidFromOnlinePayment, markInvoicePaidFromStripeBilling } = await import("@/lib/stripe/mark-paid.js");
const { activateMilestoneCheckout } = await import("@/lib/payments/milestonePaymentService.js");
const { payPageInfo } = await import("@/lib/stripe/pay-page.js");
const { createInvoiceCheckoutSession, createMilestoneCheckoutSession } = await import("@/lib/stripe/checkout.js");
const { listPendingReminders } = await import("@/lib/reminders.js");
const { sendDueDepositReminders } = await import("@/lib/reminders/deposit-send.js");

const ADMIN = "admin-lot-a@kouzia.test";
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars!!";
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: {
      email: "contact@kouzia.test",
      stripeSecretKeyEncrypted: encrypt("sk_test_fake"),
      stripeWebhookSecretEncrypted: encrypt("whsec_test"),
      moduleStripeEnabled: true,
    },
  });
  invalidateCompanySettingsCache();
  await prisma.emailOutbox.deleteMany();
  alertAdmin.mockClear();
});

/** Devis signé de 500 € : acompte de 30 % réglé (facture d'acompte émise par le paiement), solde de 70 % à régler. */
async function signedQuoteWithPaidDeposit() {
  const client = await createClient();
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt("lou@example.com") } });
  const quote = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      number: "D-2026-0100",
      clientId: client.id,
      subtotalCents: 50000,
      totalCents: 50000,
      quoteStatus: QuoteStatus.ACCEPTED,
      quoteDecidedAt: new Date(),
      issueDate: new Date(),
      lines: { create: [{ position: 1, description: "Prestation", quantity: 1, unitPriceCents: 50000, lineTotalCents: 50000 }] },
    },
  });
  const deposit = await prisma.paymentMilestone.create({
    data: { quoteId: quote.id, position: 1, label: "Acompte", percentBps: 3000, amountCents: 15000, triggerText: "Signature", status: MilestoneStatus.DUE },
  });
  const balance = await prisma.paymentMilestone.create({
    data: { quoteId: quote.id, position: 2, label: "Solde", percentBps: 7000, amountCents: 35000, triggerText: "Livraison", status: MilestoneStatus.PENDING },
  });
  await markPaidFromOnlinePayment({ amountCents: 15000, method: PaymentMethod.CARD, paymentIntentId: "pi_acompte", milestoneId: deposit.id });
  return { client, quote, deposit, balance };
}

async function issuedInvoice(clientId: string, extra: Partial<{ stripeInvoiceId: string; paymentProcessingAt: Date }> = {}) {
  return prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      number: `F-2026-0${Math.floor(Math.random() * 900 + 100)}`,
      clientId,
      subtotalCents: 10000,
      totalCents: 10000,
      issueDate: new Date(),
      issuedAt: new Date(),
      nextReminderAt: new Date(Date.now() - 3600_000),
      lines: { create: [{ position: 1, description: "Maintenance", quantity: 1, unitPriceCents: 10000, lineTotalCents: 10000 }] },
      ...extra,
    },
  });
}

const alerts = () => alertAdmin.mock.calls.length;

describe("P0 : un paiement reçu sur une échéance n'est jamais rejeté", () => {
  it("échéance « Solde » sans facture payée par Stripe : facture de solde émise et paiement enregistré, sans erreur", async () => {
    const { quote, balance } = await signedQuoteWithPaidDeposit();
    await prisma.paymentMilestone.update({ where: { id: balance.id }, data: { status: MilestoneStatus.DUE } });
    const r = await markPaidFromOnlinePayment({ amountCents: 35000, method: PaymentMethod.SEPA_DEBIT, paymentIntentId: "pi_solde", milestoneId: balance.id });
    const solde = await prisma.invoice.findFirstOrThrow({ where: { quoteId: quote.id, invoiceType: InvoiceType.SOLDE } });
    expect(r.invoiceId).toBe(solde.id);
    expect(await prisma.payment.findUnique({ where: { stripePaymentIntentId: "pi_solde" } })).toMatchObject({ invoiceId: solde.id, amountCents: 35000 });
    expect((await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: balance.id } })).status).toBe(MilestoneStatus.PAID);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: solde.id } })).status).toBe(InvoiceStatus.PAID);
  });

  it("devis déjà facturé en totalité : le paiement de l'échéance se rattache à la facture totale, une seule fois", async () => {
    const { client, quote, balance } = await signedQuoteWithPaidDeposit();
    const total = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: "F-2026-0999",
        clientId: client.id, quoteId: quote.id, subtotalCents: 50000, totalCents: 50000, issueDate: new Date(),
      },
    });
    await prisma.paymentMilestone.update({ where: { id: balance.id }, data: { label: "Deuxième acompte", status: MilestoneStatus.DUE } });
    // Audit du 28/10/2026 : l'argent reçu va sur la facture qui porte le devis, pas sur un paiement sans facture.
    await expect(
      markPaidFromOnlinePayment({ amountCents: 35000, method: PaymentMethod.CARD, paymentIntentId: "pi_orphelin", milestoneId: balance.id }),
    ).resolves.toMatchObject({ duplicate: false, invoiceId: total.id });
    expect(await prisma.payment.findUnique({ where: { stripePaymentIntentId: "pi_orphelin" } })).toMatchObject({ invoiceId: total.id, amountCents: 35000 });
    expect(await alerts()).toBe(0);
    // Renvoi du même événement par Stripe : rien en double.
    await expect(markPaidFromOnlinePayment({ amountCents: 35000, method: PaymentMethod.CARD, paymentIntentId: "pi_orphelin", milestoneId: balance.id })).resolves.toMatchObject({ duplicate: true });
    expect(await prisma.payment.count({ where: { stripePaymentIntentId: "pi_orphelin" } })).toBe(1);
  });

  it("échéance introuvable : paiement enregistré sans facture et alerte, pas d'erreur 404 renvoyée à Stripe en boucle", async () => {
    await expect(
      markPaidFromOnlinePayment({ amountCents: 12000, method: PaymentMethod.CARD, paymentIntentId: "pi_sans_jalon", milestoneId: "jalon-disparu" }),
    ).resolves.toMatchObject({ invoiceId: null });
    expect(await prisma.payment.count({ where: { stripePaymentIntentId: "pi_sans_jalon", invoiceId: null } })).toBe(1);
    expect(await alerts()).toBe(1);
  });

  it("lien de paiement du solde : la facture de solde est émise avant l'activation du lien", async () => {
    const { quote, balance } = await signedQuoteWithPaidDeposit();
    await activateMilestoneCheckout(balance.id, { sendEmail: false });
    const after = await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: balance.id } });
    const solde = await prisma.invoice.findFirst({ where: { quoteId: quote.id, invoiceType: InvoiceType.SOLDE } });
    expect(solde).not.toBeNull();
    expect(after.invoiceId).toBe(solde!.id);
    expect(after.checkoutUrl).toBeTruthy();
  });
});

describe("P1 : prélèvement SEPA en cours", () => {
  it("lien permanent d'une facture en cours de prélèvement : page sans bouton, session refusée", async () => {
    const client = await createClient();
    const inv = await issuedInvoice(client.id, { paymentProcessingAt: new Date() });
    const info = await payPageInfo("invoice", inv.id);
    expect(info?.button).toBeNull();
    expect(info?.notice).toMatch(/prélèvement/i);
    await expect(createInvoiceCheckoutSession(inv.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("échéance en cours de prélèvement : page sans bouton, session refusée", async () => {
    const { balance } = await signedQuoteWithPaidDeposit();
    await prisma.paymentMilestone.update({ where: { id: balance.id }, data: { status: MilestoneStatus.DUE, paymentProcessingAt: new Date() } });
    expect((await payPageInfo("milestone", balance.id))?.button).toBeNull();
    await expect(createMilestoneCheckoutSession(balance.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("relances et rappels d'acompte suspendus tant que le prélèvement est en cours", async () => {
    const client = await createClient();
    const processing = await issuedInvoice(client.id, { paymentProcessingAt: new Date() });
    const normal = await issuedInvoice(client.id);
    const ids = (await listPendingReminders()).map((i) => i.id);
    expect(ids).toContain(normal.id);
    expect(ids).not.toContain(processing.id);

    const { balance } = await signedQuoteWithPaidDeposit();
    await prisma.emailOutbox.deleteMany();
    const due = new Date(Date.now() - 3 * 86_400_000);
    await prisma.paymentMilestone.update({ where: { id: balance.id }, data: { status: MilestoneStatus.OVERDUE, dueDate: due, paymentProcessingAt: new Date() } });
    expect(await sendDueDepositReminders(new Date())).toBe(0);
  });
});

describe("P1 : facture d'abonnement prélevée par Stripe", () => {
  it("règlement à la main refusé quand Stripe prélève la facture", async () => {
    const client = await createClient();
    const inv = await issuedInvoice(client.id, { stripeInvoiceId: "in_test_1" });
    await prisma.user.deleteMany({ where: { email: ADMIN } });
    await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
    const cookie = `${SESSION_COOKIE}=${login.cookies.find((x) => x.name === SESSION_COOKIE)?.value}`;
    const res = await app.inject({ method: "POST", url: `/api/invoices/${inv.id}/pay`, headers: { cookie }, payload: { amountEuros: 100 } });
    expect(res.statusCode).toBe(409);
    expect(await prisma.payment.count()).toBe(0);
  });

  it("facture déjà réglée à la main puis prélevée : montant prélevé enregistré en entier et trop-perçu signalé", async () => {
    const client = await createClient();
    const inv = await issuedInvoice(client.id, { stripeInvoiceId: "in_test_2" });
    await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 10000, paidAt: new Date(), method: PaymentMethod.BANK_TRANSFER } });
    await prisma.invoice.update({ where: { id: inv.id }, data: { status: InvoiceStatus.PAID } });
    await markInvoicePaidFromStripeBilling({ erpInvoiceId: inv.id, paymentIntentId: "pi_billing_2", amountCents: 10000, method: PaymentMethod.SEPA_DEBIT });
    expect(await prisma.payment.findUnique({ where: { stripePaymentIntentId: "pi_billing_2" } })).toMatchObject({ invoiceId: inv.id, amountCents: 10000 });
    expect(await alerts()).toBe(1);
  });

  it("facture réglée en partie à la main puis prélevée : amount_paid enregistré, pas le reste dû", async () => {
    const client = await createClient();
    const inv = await issuedInvoice(client.id, { stripeInvoiceId: "in_test_3" });
    await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 4000, paidAt: new Date(), method: PaymentMethod.BANK_TRANSFER } });
    await markInvoicePaidFromStripeBilling({ erpInvoiceId: inv.id, paymentIntentId: "pi_billing_3", amountCents: 10000, method: PaymentMethod.SEPA_DEBIT });
    expect((await prisma.payment.findUniqueOrThrow({ where: { stripePaymentIntentId: "pi_billing_3" } })).amountCents).toBe(10000);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe(InvoiceStatus.PAID);
    expect(await alerts()).toBe(1);
  });
});
