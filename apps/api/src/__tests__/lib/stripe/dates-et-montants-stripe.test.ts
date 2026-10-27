import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Décisions du 27/10/2026 :
// - date d'encaissement Stripe = date du paiement chez Stripe (événement), pas l'heure de traitement du webhook : un
//   paiement du 31/03 traité le 01/04 reste dans le livre des recettes et la déclaration URSSAF de mars ;
// - facture Stripe en retard (webhook rejoué) : datée du jour de son émission, période sur la ligne ;
// - facture Stripe au total et aux lignes de la facture Stripe, pas au montant restant à prélever (amount_due), qui
//   déduit le solde client Stripe.
const stripeMock = {
  paymentIntents: { retrieve: vi.fn(async () => { throw new Error("hors ligne"); }) },
  subscriptions: { retrieve: vi.fn(async () => { throw new Error("hors ligne"); }), deleteDiscount: vi.fn() },
};
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => stripeMock),
  getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_fake", webhookSecret: "whsec", mode: "test" as const, enabled: true })),
}));
vi.mock("@/lib/email/smtp.js", async (orig) => ({ ...(await orig<typeof import("@/lib/email/smtp.js")>()), isSmtpConfigured: async () => false }));
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin: vi.fn(async () => undefined) }));

const { processStripeEvent } = await import("@/lib/stripe/webhook-handlers.js");
const { issueErpInvoiceFromStripeInvoice } = await import("@/lib/stripe/billing.js");

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
// 31 mars 2026, 23 h 30 à Paris (21 h 30 UTC).
const PAID_AT = new Date(Date.UTC(2026, 2, 31, 21, 30, 0));

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake") } });
  invalidateCompanySettingsCache();
});

async function stripeSubscription() {
  const client = await createClient({ displayName: "Atelier Stripe" });
  const service = await prisma.service.create({ data: { name: "Site", unitPriceCents: 150000, unit: "FORFAIT", active: true, isSubscription: true, billingInterval: "YEAR" } });
  return prisma.subscription.create({
    data: {
      clientId: client.id, serviceId: service.id, label: "Site tout compris", amountCents: 150000, billingDay: 1, billingInterval: "YEAR",
      startDate: new Date(2026, 0, 1), nextInvoiceAt: new Date(2026, 0, 1), status: SubscriptionStatus.ACTIVE,
      collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_dates",
    },
  });
}

function stripeInvoice(over: Record<string, unknown> = {}): Stripe.Invoice {
  const start = sec(new Date(2026, 0, 1));
  const end = sec(new Date(2027, 0, 1));
  return {
    id: "in_dates",
    total: 150000,
    amount_due: 150000,
    amount_paid: 150000,
    total_discount_amounts: [],
    period_start: start,
    period_end: end,
    status_transitions: { paid_at: sec(PAID_AT) },
    parent: { subscription_details: { subscription: "sub_dates" } },
    billing_reason: "subscription_cycle",
    lines: { data: [{ description: "1 × Site tout compris (at €1,500.00 / year)", amount: 150000, period: { start, end } }] },
    ...over,
  } as unknown as Stripe.Invoice;
}

describe("date d'encaissement Stripe", () => {
  it("payment_intent.succeeded : paiement daté de l'événement Stripe", async () => {
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: { documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: "F-2026-0001", clientId: client.id, subtotalCents: 5000, totalCents: 5000, issueDate: new Date(2026, 2, 1) },
    });
    await processStripeEvent({
      id: "evt_pi_date", type: "payment_intent.succeeded", created: sec(PAID_AT),
      data: { object: { id: "pi_date", amount: 5000, amount_received: 5000, metadata: { erpInvoiceId: inv.id } } },
    } as unknown as Stripe.Event);
    const payment = await prisma.payment.findFirstOrThrow({ where: { invoiceId: inv.id } });
    expect(payment.paidAt.toISOString()).toBe(PAID_AT.toISOString());
  });

  it("invoice.paid : paiement daté du paiement de la facture Stripe", async () => {
    await stripeSubscription();
    await processStripeEvent({ id: "evt_inv_paid", type: "invoice.paid", created: sec(PAID_AT) + 3600 * 30, data: { object: stripeInvoice() } } as unknown as Stripe.Event);
    const payment = await prisma.payment.findFirstOrThrow();
    expect(payment.paidAt.toISOString()).toBe(PAID_AT.toISOString());
  });
});

describe("facture Stripe en retard", () => {
  it("datée du jour de son émission, période sur la ligne", async () => {
    await stripeSubscription();
    const { invoiceId } = await issueErpInvoiceFromStripeInvoice(stripeInvoice());
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
    const today = new Date();
    expect([inv.issueDate!.getFullYear(), inv.issueDate!.getMonth(), inv.issueDate!.getDate()]).toEqual([today.getFullYear(), today.getMonth(), today.getDate()]);
    expect(inv.lines[0]!.description).toContain("01/01/2026");
  });
});
