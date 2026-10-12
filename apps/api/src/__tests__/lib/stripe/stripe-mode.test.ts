import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

function listOf<T>(items: T[]) {
  return Object.assign(Promise.resolve({ data: items, has_more: false }), {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  });
}

const keyMode = { current: "test" as "test" | "live" };
const stripe = {
  subscriptions: { cancel: vi.fn(async (_id: string): Promise<unknown> => ({})), update: vi.fn(async () => ({})) },
  customers: { create: vi.fn(async () => ({ id: "cus_test_1" })) },
  prices: { list: vi.fn((_p?: unknown) => listOf([] as Stripe.Price[])) },
};
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => stripe),
  getStripeConfig: vi.fn(async () => ({
    secretKey: `sk_${keyMode.current}_x`,
    webhookSecret: null,
    mode: keyMode.current,
    enabled: true,
  })),
}));
vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "o", messageId: "<m>" })),
}));

const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { endSubscription } = await import("@/lib/subscriptions/subscription-service.js");
const { StripeModeError, backfillStripeModes } = await import("@/lib/stripe/mode.js");
const { StripeSubscriptionSyncError } = await import("@/lib/stripe/subscription-control.js");
const { ensureStripeCustomer } = await import("@/lib/stripe/customers.js");
const { syncCatalogFromStripe } = await import("@/lib/stripe/catalog.js");
const { processStripeEvent } = await import("@/lib/stripe/webhook-handlers.js");
const { subscriptionPriceData } = await import("@/lib/stripe/checkout.js");
const { savePaymentsTab } = await import("@/lib/settings/service.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  keyMode.current = "test";
  stripe.subscriptions.cancel.mockReset().mockResolvedValue({});
  stripe.customers.create.mockClear();
  stripe.prices.list.mockImplementation(() => listOf([] as Stripe.Price[]));
  vi.mocked(mailEnqueue).mockClear();
});

async function stripeSubscription(livemode: boolean | null) {
  const c = await createClient();
  const s = await createService();
  return prisma.subscription.create({
    data: {
      clientId: c.id,
      serviceId: s.id,
      label: "Maintenance",
      amountCents: 2_900,
      billingDay: 1,
      startDate: new Date(2026, 0, 1),
      nextInvoiceAt: new Date(2026, 11, 1),
      collectionMethod: SubscriptionCollectionMethod.STRIPE,
      stripeSubscriptionId: "sub_live_1",
      stripeLivemode: livemode,
    },
  });
}

describe("abonnement d'un autre mode", () => {
  it("clé test, abonnement live : refus explicite, Stripe non appelé, rien ne change", async () => {
    const sub = await stripeSubscription(true);
    await expect(endSubscription(sub.id)).rejects.toThrow(
      "Cet abonnement est lié à Stripe en mode live, la clé actuelle est en mode test",
    );
    await expect(endSubscription(sub.id)).rejects.toBeInstanceOf(StripeModeError);
    expect(stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(SubscriptionStatus.ACTIVE);
  });

  it("introuvable dans Stripe et mode inconnu : PAS interprété comme une résiliation", async () => {
    const sub = await stripeSubscription(null);
    stripe.subscriptions.cancel.mockRejectedValueOnce(Object.assign(new Error("No such subscription"), { code: "resource_missing" }));
    await expect(endSubscription(sub.id)).rejects.toBeInstanceOf(StripeSubscriptionSyncError);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(SubscriptionStatus.ACTIVE);
  });

  it("introuvable dans Stripe, même mode : résiliation déjà faite, clôture", async () => {
    const sub = await stripeSubscription(false);
    stripe.subscriptions.cancel.mockRejectedValueOnce(Object.assign(new Error("No such subscription"), { code: "resource_missing" }));
    expect((await endSubscription(sub.id)).status).toBe(SubscriptionStatus.ENDED);
  });
});

describe("client Stripe", () => {
  it("customer live et clé test : refus, aucun customer test créé à sa place", async () => {
    const c = await createClient();
    await prisma.client.update({ where: { id: c.id }, data: { stripeCustomerId: "cus_live", stripeCustomerLivemode: true } });
    await expect(ensureStripeCustomer(c.id)).rejects.toBeInstanceOf(StripeModeError);
    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).stripeCustomerId).toBe("cus_live");
  });

  it("nouveau customer : mode de la clé enregistré", async () => {
    const c = await createClient();
    await ensureStripeCustomer(c.id);
    expect(await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({
      stripeCustomerId: "cus_test_1",
      stripeCustomerLivemode: false,
    });
  });
});

function testPrice(id: string): Stripe.Price {
  return {
    id,
    livemode: false,
    currency: "eur",
    unit_amount: 1_000,
    type: "one_time",
    recurring: null,
    metadata: {},
    product: { id: `prod_${id}`, active: true, name: `Test ${id}`, description: null, default_price: id },
  } as unknown as Stripe.Price;
}

async function liveService(n: number) {
  return prisma.service.create({
    data: { name: `Live ${n}`, unitPriceCents: 1_000, stripeProductId: `prod_l${n}`, stripePriceId: `price_l${n}`, stripeLivemode: true },
  });
}

describe("synchro du catalogue", () => {
  it("clé test : les prestations live ne sont pas archivées ; les prix test sont marqués test", async () => {
    for (const n of [1, 2, 3, 4, 5]) await liveService(n);
    stripe.prices.list.mockImplementation(() => listOf([testPrice("price_t1")]));
    await syncCatalogFromStripe();
    expect(await prisma.service.count({ where: { stripeLivemode: true, active: true } })).toBe(5);
    expect(await prisma.service.findFirstOrThrow({ where: { stripePriceId: "price_t1" } })).toMatchObject({ stripeLivemode: false });
  });

  it("filet : plus de 3 prestations à archiver d'un coup, refus et alerte", async () => {
    keyMode.current = "live";
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) await liveService(n);
    const actions = await syncCatalogFromStripe();
    expect(actions.filter((a) => a.action === "blocked")).toHaveLength(10);
    expect(await prisma.service.count({ where: { active: true } })).toBe(10);
    expect(vi.mocked(mailEnqueue).mock.calls[0]?.[0].subject).toBe("Synchro Stripe bloquée : archivage massif refusé");
  });

  it("filet : plus de 20 % (2 sur 5) refusé ; 1 seule prestation archivée reste permise", async () => {
    keyMode.current = "live";
    for (const n of [1, 2, 3, 4, 5]) await liveService(n);
    const live = (ids: string[]) =>
      ids.map((id) => ({ ...testPrice(id), livemode: true, product: { ...(testPrice(id).product as object), id: `prod_${id}` } }));
    stripe.prices.list.mockImplementation(() => listOf(live(["price_l1", "price_l2", "price_l3"]) as unknown as Stripe.Price[]));
    expect((await syncCatalogFromStripe()).some((a) => a.action === "blocked")).toBe(true);
    stripe.prices.list.mockImplementation(() =>
      listOf(live(["price_l1", "price_l2", "price_l3", "price_l4"]) as unknown as Stripe.Price[]),
    );
    const actions = await syncCatalogFromStripe();
    expect(actions.find((a) => a.action === "archive")?.stripePriceId).toBe("price_l5");
  });
});

describe("webhook et Checkout", () => {
  it("événement live avec une clé test : ignoré", async () => {
    const sub = await stripeSubscription(true);
    const res = await processStripeEvent({
      id: "evt_live_1",
      type: "customer.subscription.deleted",
      livemode: true,
      data: { object: { id: "sub_live_1", status: "canceled", metadata: { erpSubscriptionId: sub.id }, items: { data: [] } } },
    } as unknown as Stripe.Event);
    expect(res.handled).toBe("ignoré (événement live, clé test)");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(SubscriptionStatus.ACTIVE);
  });

  it("produit live et clé test : le prix d'abonnement n'utilise pas le produit live", () => {
    const data = subscriptionPriceData(
      { amountCents: 2_900, billingInterval: "MONTH", label: "Maintenance", service: { stripeProductId: "prod_live", billingInterval: "MONTH", stripeLivemode: true } },
      false,
    );
    expect(data).toMatchObject({ product_data: { name: "Maintenance" } });
    expect("product" in data).toBe(false);
  });
});

describe("mode de la clé", () => {
  it("complète le mode des identifiants existants selon la clé configurée", async () => {
    await prisma.companySettings.updateMany({ data: { stripeSecretKeyEncrypted: encrypt("sk_live_abc"), stripeKeyMode: null } });
    const svc = await prisma.service.create({ data: { name: "S", unitPriceCents: 100, stripePriceId: "price_x" } });
    expect(await backfillStripeModes()).toBe(1);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).stripeLivemode).toBe(true);
    expect((await prisma.companySettings.findFirstOrThrow()).stripeKeyMode).toBe("live");
  });

  it("clé d'un autre mode : confirmation exigée, puis enregistrée", async () => {
    await prisma.companySettings.updateMany({
      data: { stripeSecretKeyEncrypted: encrypt("sk_live_abc"), stripeSecretKeyHint: "…abc", stripeKeyMode: "live" },
    });
    await expect(savePaymentsTab({ stripeSecretKey: "sk_test_new" })).rejects.toMatchObject({
      statusCode: 409,
      code: "stripe_mode_change",
    });
    expect((await prisma.companySettings.findFirstOrThrow()).stripeKeyMode).toBe("live");
    await savePaymentsTab({ stripeSecretKey: "sk_test_new", confirmStripeModeChange: true });
    expect((await prisma.companySettings.findFirstOrThrow()).stripeKeyMode).toBe("test");
  });
});
