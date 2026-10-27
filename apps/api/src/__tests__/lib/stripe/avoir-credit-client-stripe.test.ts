import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Décision du 27/10/2026 (option A) : facture Stripe de 160 € dont 50 € réglés par le crédit du client Stripe (baisse de
// formule proratisée, ajustement), 110 € prélevés. La facture ERP reste au total Stripe ; un avoir automatique de 50 €
// « Crédit client Stripe appliqué » la solde (Payée) ; aucune recette en double (livre des recettes, URSSAF) ; l'avoir
// n'est pas envoyé au client, Alexandre est notifié ; idempotent si le webhook est rejoué.
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
const { syncObligationsLocal } = await import("@/lib/obligations/obligation-service.js");
const { listNotifications } = await import("@/lib/notifications/feed.js");

const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const PAID_AT = new Date(2026, 8, 15, 10, 0);

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: { moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake"), businessStartDate: new Date(2026, 0, 1), urssafPeriodicity: "MONTHLY" },
  });
  invalidateCompanySettingsCache();
  const client = await createClient({ displayName: "Atelier Crédit" });
  const service = await prisma.service.create({ data: { name: "Site", unitPriceCents: 160000, unit: "FORFAIT", active: true, isSubscription: true, billingInterval: "YEAR" } });
  await prisma.subscription.create({
    data: {
      clientId: client.id, serviceId: service.id, label: "Site tout compris", amountCents: 160000, billingDay: 15, billingInterval: "YEAR",
      startDate: new Date(2026, 8, 15), nextInvoiceAt: new Date(2026, 8, 15), status: SubscriptionStatus.ACTIVE,
      collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_credit",
    },
  });
});

function paidEvent(eventId: string): Stripe.Event {
  const start = sec(new Date(2026, 8, 15));
  const end = sec(new Date(2027, 8, 15));
  return {
    id: eventId,
    type: "invoice.paid",
    created: sec(PAID_AT),
    data: {
      object: {
        id: "in_credit",
        total: 160000,
        amount_due: 110000,
        amount_paid: 110000,
        starting_balance: -50000,
        ending_balance: 0,
        total_discount_amounts: [],
        period_start: start,
        period_end: end,
        status_transitions: { paid_at: sec(PAID_AT) },
        parent: { subscription_details: { subscription: "sub_credit" } },
        billing_reason: "subscription_cycle",
        lines: { data: [{ description: "Site tout compris", amount: 160000, period: { start, end } }] },
      },
    },
  } as unknown as Stripe.Event;
}

describe("crédit client Stripe appliqué à une facture", () => {
  it("facture au total Stripe, Payée par un avoir automatique ; recettes et URSSAF sur 110 € seulement ; avoir non envoyé, notifié", async () => {
    const since = new Date(Date.now() - 1000);
    await processStripeEvent(paidEvent("evt_credit_1"));
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { stripeInvoiceId: "in_credit" }, include: { creditNotes: true } });
    expect(invoice.totalCents).toBe(160000);
    expect(invoice.status).toBe("PAID");
    expect(invoice.creditNotes).toHaveLength(1);
    const avoir = invoice.creditNotes[0]!;
    expect(avoir.totalCents).toBe(-50000);
    expect(avoir.creditReason).toBe("STRIPE_CUSTOMER_CREDIT");
    expect(avoir.number).toMatch(/^A-/);

    // Livre des recettes : seul le prélèvement compte.
    const receipts = await prisma.payment.aggregate({ where: { paidAt: { gte: new Date(2026, 8, 1), lte: new Date(2026, 8, 30, 23, 59) } }, _sum: { amountCents: true } });
    expect(receipts._sum.amountCents).toBe(110000);
    // URSSAF de septembre 2026 sur 1 100 € (pas 1 600) : cotisations 25,6 % arrondies à l'euro par modele-social (282 €)
    // et CFP 0,2 % (2,20 €).
    await syncObligationsLocal(new Date(2026, 9, 10, 9));
    expect((await prisma.obligation.findFirstOrThrow({ where: { type: "URSSAF_DECLARATION", period: "2026-09" } })).amountCents).toBe(28420);

    // Pas d'envoi au client, notification à Alexandre.
    expect(await prisma.emailOutbox.count({ where: { documentId: avoir.id } })).toBe(0);
    const notes = await listNotifications(since);
    expect(notes.some((n) => n.kind === "stripe_credit" && n.href === `/invoices/${avoir.id}`)).toBe(true);
  });

  it("webhook rejoué (autre événement, même facture) : un seul avoir", async () => {
    await processStripeEvent(paidEvent("evt_credit_1"));
    await processStripeEvent(paidEvent("evt_credit_2"));
    expect(await prisma.invoice.count({ where: { documentType: "CREDIT_NOTE", creditReason: "STRIPE_CUSTOMER_CREDIT" } })).toBe(1);
  });
});
