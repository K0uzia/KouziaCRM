import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  PaymentMethod,
  SubscriptionCollectionMethod,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings, createClient } from "../../helpers/factories.js";
import { encrypt } from "@/lib/crypto.js";
import { detectStripeMode } from "@/lib/stripe/client.js";
import { signPayToken, verifyPayToken } from "@/lib/stripe/pay-token.js";
import { markPaidFromOnlinePayment } from "@/lib/stripe/mark-paid.js";
import { processStripeEvent } from "@/lib/stripe/webhook-handlers.js";
import { syncCatalogFromStripe } from "@/lib/stripe/catalog.js";
import { issueErpInvoiceFromStripeInvoice } from "@/lib/stripe/billing.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";

vi.mock("@/lib/email/smtp.js", () => ({
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: vi.fn(async () => false),
}));

vi.mock("@/lib/stripe/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe/client.js")>();
  return {
    ...actual,
    getStripe: vi.fn(async () => mockStripe),
    getStripeConfig: vi.fn(async () => ({
      secretKey: "sk_test_fake",
      webhookSecret: "whsec_test_secret",
      mode: "test" as const,
      enabled: true,
    })),
  };
});

/** Liste Stripe simulée : promesse ET itérable asynchrone (pagination automatique du SDK). */
function listOf<T>(items: T[]) {
  const page = { data: items, has_more: false };
  return Object.assign(Promise.resolve(page), {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  });
}

const mockStripe = {
  prices: {
    list: vi.fn((_params?: unknown) => listOf([] as Stripe.Price[])),
  },
  paymentIntents: {
    retrieve: vi.fn(async (id: string) => ({
      id,
      latest_charge: {
        balance_transaction: { fee: 42 },
      },
    })),
  },
  balanceTransactions: {
    list: vi.fn(async () => ({ data: [] })),
  },
};

beforeEach(async () => {
  process.env.SESSION_SECRET = "test-session-secret-32chars!!";
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: {
      moduleStripeEnabled: true,
      stripeSecretKeyEncrypted: encrypt("sk_test_fake"),
      stripeWebhookSecretEncrypted: encrypt("whsec_test_secret"),
      email: "admin@kouzia.test",
    },
  });
  invalidateCompanySettingsCache();
  mockStripe.prices.list.mockImplementation(() => listOf([] as Stripe.Price[]));
});

afterEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

describe("detectStripeMode", () => {
  it("détecte test et live", () => {
    expect(detectStripeMode("sk_test_abc")).toBe("test");
    expect(detectStripeMode("sk_live_abc")).toBe("live");
    expect(detectStripeMode("rk_live_abc")).toBe("live");
  });
});

describe("pay token", () => {
  it("signe et vérifie un jeton", () => {
    const token = signPayToken("invoice", "inv_1");
    expect(verifyPayToken(token)).toEqual({ kind: "invoice", id: "inv_1" });
    expect(verifyPayToken("bad.token")).toBeNull();
  });
});

describe("markPaidFromOnlinePayment", () => {
  it("paie une facture simple avec frais", async () => {
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        number: "F-2026-0001",
        clientId: client.id,
        subtotalCents: 10000,
        totalCents: 10000,
        issueDate: new Date(),
      },
    });

    const r = await markPaidFromOnlinePayment({
      amountCents: 10000,
      method: PaymentMethod.CARD,
      paymentIntentId: "pi_simple_1",
      feeCents: 29,
      invoiceId: inv.id,
    });
    expect(r.duplicate).toBe(false);
    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(updated.status).toBe(InvoiceStatus.PAID);
    const pay = await prisma.payment.findFirstOrThrow();
    expect(pay.feeCents).toBe(29);
    expect(pay.stripePaymentIntentId).toBe("pi_simple_1");
  });
});

describe("processStripeEvent", () => {
  it("vérifie l'idempotence sur eventId", async () => {
    const event = {
      id: "evt_idem_1",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: "pi_refund",
          amount_refunded: 100,
        },
      },
    } as unknown as Stripe.Event;

    const first = await processStripeEvent(event);
    expect(first.duplicate).toBe(false);
    const second = await processStripeEvent(event);
    expect(second.duplicate).toBe(true);
  });

  it("paie une facture via payment_intent.succeeded", async () => {
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        number: "F-2026-0002",
        clientId: client.id,
        subtotalCents: 5000,
        totalCents: 5000,
        issueDate: new Date(),
      },
    });

    const event = {
      id: "evt_pi_ok",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: "pi_webhook_1",
          amount: 5000,
          amount_received: 5000,
          payment_method_types: ["card"],
          metadata: { erpInvoiceId: inv.id },
        },
      },
    } as unknown as Stripe.Event;

    await processStripeEvent(event);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe(
      InvoiceStatus.PAID,
    );
    expect((await prisma.payment.findFirstOrThrow()).feeCents).toBe(42);
  });
});

describe("syncCatalogFromStripe", () => {
  it("crée une prestation depuis un prix Stripe", async () => {
    mockStripe.prices.list.mockImplementation(() =>
      listOf([
        {
          id: "price_1",
          active: true,
          currency: "eur",
          unit_amount: 4900,
          type: "recurring",
          recurring: { interval: "month" },
          product: {
            id: "prod_1",
            active: true,
            name: "Maintenance Sérénité",
            description: "Suivi mensuel",
            deleted: undefined,
          },
        } as unknown as Stripe.Price,
      ]),
    );

    const actions = await syncCatalogFromStripe();
    expect(actions.some((a) => a.action === "create")).toBe(true);
    const svc = await prisma.service.findFirst({ where: { stripePriceId: "price_1" } });
    expect(svc?.name).toBe("Maintenance Sérénité");
    expect(svc?.unitPriceCents).toBe(4900);
    expect(svc?.isSubscription).toBe(true);
  });
});

describe("facture abonnement Stripe", () => {
  it("émet une facture ERP depuis invoice.finalized sans doublon", async () => {
    const client = await createClient();
    const service = await prisma.service.create({
      data: {
        name: "Maint",
        unitPriceCents: 4900,
        unit: "FORFAIT",
        active: true,
        isSubscription: true,
        stripePriceId: "price_sub",
        stripeProductId: "prod_sub",
        billingInterval: "MONTH",
      },
    });
    await prisma.subscription.create({
      data: {
        clientId: client.id,
        serviceId: service.id,
        label: "Maintenance",
        amountCents: 4900,
        billingDay: 1,
        startDate: new Date(),
        nextInvoiceAt: new Date(),
        status: SubscriptionStatus.ACTIVE,
        collectionMethod: SubscriptionCollectionMethod.STRIPE,
        stripeSubscriptionId: "sub_stripe_1",
      },
    });

    const stripeInvoice = {
      id: "in_stripe_1",
      amount_due: 4900,
      amount_paid: 0,
      period_start: Math.floor(Date.now() / 1000),
      period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
      parent: { subscription_details: { subscription: "sub_stripe_1" } },
      customer_email: null,
      lines: { data: [] },
    } as unknown as Stripe.Invoice;

    const first = await issueErpInvoiceFromStripeInvoice(stripeInvoice);
    expect(first.created).toBe(true);
    const second = await issueErpInvoiceFromStripeInvoice(stripeInvoice);
    expect(second.created).toBe(false);
    expect(second.invoiceId).toBe(first.invoiceId);
    expect(await prisma.invoice.count({ where: { stripeInvoiceId: "in_stripe_1" } })).toBe(1);
  });
});

describe("signature webhook Stripe", () => {
  it("accepte un en-tête généré et refuse un corps altéré", () => {
    const payload = JSON.stringify({
      id: "evt_sig_1",
      object: "event",
      type: "charge.refunded",
      data: { object: { id: "ch_1" } },
    });
    const secret = "whsec_test_secret";
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(() => Stripe.webhooks.constructEvent(payload, header, secret)).not.toThrow();
    expect(() =>
      Stripe.webhooks.constructEvent(payload.replace("evt_sig_1", "x"), header, secret),
    ).toThrow();
  });
});

describe("checkout document déjà payé", () => {
  it("refuse une session sur facture déjà payée", async () => {
    const { createInvoiceCheckoutSession } = await import("@/lib/stripe/checkout.js");
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.PAID,
        number: "F-2026-0009",
        clientId: client.id,
        subtotalCents: 1000,
        totalCents: 1000,
        issueDate: new Date(),
      },
    });
    await expect(createInvoiceCheckoutSession(inv.id)).rejects.toThrow(/déjà réglée/);
  });
});

// --- Revue du lot Stripe (fix/stripe-revue) ---

const subscriptionInvoiceEvent = (id: string, type: string, amountCents: number) =>
  ({
    id,
    type,
    data: {
      object: {
        id: `in_${id}`,
        amount_due: amountCents,
        total: amountCents,
        amount_paid: 0,
        billing_reason: "subscription_create",
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        parent: { subscription_details: { subscription: "sub_rev_1" } },
        lines: { data: [] },
      },
    },
  }) as unknown as Stripe.Event;

async function stripeSubscription() {
  const client = await createClient();
  const service = await prisma.service.create({
    data: { name: "Maint", unitPriceCents: 4900, unit: "FORFAIT", active: true, isSubscription: true },
  });
  return prisma.subscription.create({
    data: {
      clientId: client.id,
      serviceId: service.id,
      label: "Maintenance",
      amountCents: 4900,
      billingDay: 1,
      startDate: new Date(),
      nextInvoiceAt: new Date(),
      status: SubscriptionStatus.ACTIVE,
      collectionMethod: SubscriptionCollectionMethod.STRIPE,
      stripeSubscriptionId: "sub_rev_1",
    },
  });
}

describe("webhooks Stripe : revue", () => {
  it("un traitement en échec n'est pas marqué traité : le renvoi de Stripe est retraité", async () => {
    // Abonnement absent au premier envoi : erreur, donc réponse 500 et renvoi par Stripe.
    const event = subscriptionInvoiceEvent("evt_retry", "invoice.finalized", 4900);
    await expect(processStripeEvent(event)).rejects.toThrow();
    expect(await prisma.stripeWebhookEvent.count({ where: { eventId: "evt_retry" } })).toBe(0);

    await stripeSubscription();
    const again = await processStripeEvent(event);
    expect(again.duplicate).toBe(false);
    expect(await prisma.invoice.count({ where: { stripeInvoiceId: "in_evt_retry" } })).toBe(1);
    expect((await processStripeEvent(event)).duplicate).toBe(true);
  });

  it("facture d'abonnement à 0 € (essai) : aucune facture ERP numérotée", async () => {
    await stripeSubscription();
    const res = await processStripeEvent(subscriptionInvoiceEvent("evt_zero", "invoice.finalized", 0));
    expect(res.handled).toMatch(/0 €/);
    expect(await prisma.invoice.count()).toBe(0);
  });

  it("prélèvement d'abonnement (PaymentIntent sans document ERP) : ignoré, sans erreur", async () => {
    const event = {
      id: "evt_pi_sub",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_sub", amount: 4900, amount_received: 4900, payment_method_types: ["sepa_debit"], metadata: {} } },
    } as unknown as Stripe.Event;
    const res = await processStripeEvent(event);
    expect(res.handled).toMatch(/ignoré/);
    expect(await prisma.payment.count()).toBe(0);
  });
});

describe("Checkout : revue", () => {
  it("abonnement prélevé au montant ERP et à sa périodicité (mensuelle ou annuelle)", async () => {
    const { subscriptionPriceData } = await import("@/lib/stripe/checkout.js");
    const monthly = subscriptionPriceData({
      amountCents: 3900,
      billingInterval: null,
      label: "Maintenance négociée",
      service: { stripeProductId: "prod_1", billingInterval: "MONTH" },
    });
    expect(monthly).toMatchObject({ unit_amount: 3900, recurring: { interval: "month" }, product: "prod_1" });
    const yearly = subscriptionPriceData({
      amountCents: 39000,
      billingInterval: "YEAR",
      label: "Maintenance annuelle",
      service: { stripeProductId: null, billingInterval: "MONTH" },
    });
    expect(yearly).toMatchObject({ unit_amount: 39000, recurring: { interval: "year" }, product_data: { name: "Maintenance annuelle" } });
  });

  it("jalon : refusé avant la signature, et pour un 2e acompte en attente de son étape", async () => {
    const { assertMilestonePayable } = await import("@/lib/stripe/checkout.js");
    const base = { status: "DUE" as const, position: 1 };
    expect(() => assertMilestonePayable({ ...base, quote: { quoteStatus: "SENT", paymentPlan: null } })).toThrow(/signé/);
    expect(() =>
      assertMilestonePayable({ status: "PENDING", position: 2, quote: { quoteStatus: "ACCEPTED", paymentPlan: "THREE" } }),
    ).toThrow(/étape/);
    expect(() =>
      assertMilestonePayable({ status: "DUE", position: 2, quote: { quoteStatus: "ACCEPTED", paymentPlan: "THREE" } }),
    ).not.toThrow();
  });
});

describe("catalogue : revue", () => {
  it("rapproche par nom seulement une prestation non liée ; une prestation liée ailleurs n'est pas reprise", async () => {
    await prisma.service.create({
      data: { name: "Site vitrine", unitPriceCents: 129000, unit: "FORFAIT", active: true, stripePriceId: "price_autre" },
    });
    mockStripe.prices.list.mockImplementation(() =>
      listOf([
        {
          id: "price_nouveau",
          active: true,
          currency: "eur",
          unit_amount: 99000,
          type: "one_time",
          product: { id: "prod_x", active: true, name: "Site vitrine", description: null },
        } as unknown as Stripe.Price,
      ]),
    );
    await syncCatalogFromStripe();
    const liee = await prisma.service.findFirstOrThrow({ where: { stripePriceId: "price_autre" } });
    expect(liee.unitPriceCents).toBe(129000);
    expect(await prisma.service.count({ where: { stripePriceId: "price_nouveau" } })).toBe(1);
  });
});

describe("jeton de paiement : revue", () => {
  it("signé avec une clé dérivée, pas avec SESSION_SECRET directement", async () => {
    const { createHmac } = await import("node:crypto");
    const token = signPayToken("invoice", "inv_1");
    const [body, sig] = token.split(".");
    const rawKeySig = createHmac("sha256", process.env.SESSION_SECRET!).update(body!).digest("base64url");
    expect(sig).not.toBe(rawKeySig);
    expect(verifyPayToken(token)).toEqual({ kind: "invoice", id: "inv_1" });
  });
});
