import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

function listOf<T>(items: T[]) {
  return Object.assign(Promise.resolve({ data: items, has_more: false }), {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  });
}

let seq = 0;
const stripe = {
  products: {
    create: vi.fn(async (_p: unknown, _o?: unknown) => ({ id: "prod_new" })),
    update: vi.fn(async (_id: string, _p: unknown) => ({})),
    retrieve: vi.fn(async (_id: string) => ({ id: "prod_1", default_price: "price_m" })),
  },
  prices: {
    create: vi.fn(async (_p: unknown, _o?: unknown) => ({ id: `price_new_${++seq}` })),
    update: vi.fn(async (_id: string, _p: unknown) => ({})),
    list: vi.fn((_p?: unknown) => listOf([] as Stripe.Price[])),
  },
};
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => stripe),
  getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_x", webhookSecret: null, mode: "test", enabled: true })),
}));

const { createLinkedService } = await import("@/lib/stripe/catalog-write.js");
const { syncCatalogFromStripe } = await import("@/lib/stripe/catalog.js");
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-catalogue@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: true } });
  for (const group of [stripe.products, stripe.prices]) for (const fn of Object.values(group)) fn.mockClear();
  stripe.products.create.mockImplementation(async () => ({ id: "prod_new" }));
  stripe.prices.create.mockImplementation(async () => ({ id: `price_new_${++seq}` }));
  stripe.prices.list.mockImplementation(() => listOf([] as Stripe.Price[]));
  // Session créée directement : resetDb vide les sessions et la connexion est limitée en débit.
  const user = await prisma.user.upsert({
    where: { email: ADMIN },
    update: {},
    create: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) },
  });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const REQ = "8c1f0a52-2a5e-4f0b-9d3c-3f6f4b9a1e11";

function stripePrice(id: string, productDefault: string, extra: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id,
    currency: "eur",
    unit_amount: 2_900,
    type: "recurring",
    recurring: { interval: "month" },
    metadata: {},
    product: { id: "prod_1", active: true, name: "Maintenance", description: null, default_price: productDefault },
    ...extra,
  } as unknown as Stripe.Price;
}

describe("créer une prestation avec Stripe actif", () => {
  it("abonnement annuel : produit puis prix récurrent dans Stripe, prestation liée", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/services",
      headers: { cookie },
      payload: {
        name: "Maintenance",
        description: "Sauvegardes",
        unitPriceEuros: 290,
        isSubscription: true,
        billingInterval: "YEAR",
        requestId: REQ,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(stripe.products.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Maintenance", description: "Sauvegardes" }),
      { idempotencyKey: `kouzia-service-product-${REQ}` },
    );
    expect(stripe.prices.create).toHaveBeenCalledWith(
      { product: "prod_new", currency: "eur", unit_amount: 29_000, recurring: { interval: "year" } },
      { idempotencyKey: `kouzia-service-price-${REQ}` },
    );
    expect(res.json()).toMatchObject({
      name: "Maintenance (annuel)",
      isSubscription: true,
      billingInterval: "YEAR",
      stripeProductId: "prod_new",
      unitPriceCents: 29_000,
    });
  });

  it("prestation ponctuelle : prix sans récurrence", async () => {
    await app.inject({
      method: "POST",
      url: "/api/services",
      headers: { cookie },
      payload: { name: "Site vitrine", unitPriceEuros: 1290, requestId: REQ },
    });
    const params = stripe.prices.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.recurring).toBeUndefined();
  });

  it("Stripe en échec : 502, rien de créé dans l'ERP", async () => {
    stripe.prices.create.mockRejectedValueOnce(new Error("Invalid API Key provided."));
    const res = await app.inject({
      method: "POST",
      url: "/api/services",
      headers: { cookie },
      payload: { name: "Site vitrine", unitPriceEuros: 1290, requestId: REQ },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe(
      "Stripe n'a pas créé la prestation : rien n'a été enregistré. Détail Stripe : Invalid API Key provided.",
    );
    expect(await prisma.service.count()).toBe(0);
  });

  it("webhook arrivé avant la fin (synchro a déjà créé la prestation) : pas de doublon", async () => {
    stripe.prices.create.mockImplementationOnce(async () => {
      await prisma.service.create({
        data: { name: "Site vitrine", unitPriceCents: 129_000, stripeProductId: "prod_new", stripePriceId: "price_race" },
      });
      return { id: "price_race" };
    });
    const svc = await createLinkedService({
      name: "Site vitrine",
      description: null,
      unitPriceCents: 129_000,
      isSubscription: false,
      billingInterval: null,
      defaultBillingDay: 1,
      requestId: REQ,
    });
    expect(svc.stripePriceId).toBe("price_race");
    expect(await prisma.service.count()).toBe(1);
  });
});

describe("changer le prix d'une prestation liée", () => {
  async function linked() {
    return prisma.service.create({
      data: {
        name: "Maintenance",
        unitPriceCents: 2_900,
        isSubscription: true,
        billingInterval: "MONTH",
        stripeProductId: "prod_1",
        stripePriceId: "price_m",
      },
    });
  }

  it("nouveau prix (même produit, même périodicité), prix par défaut, ancien archivé", async () => {
    const svc = await linked();
    const res = await app.inject({
      method: "PUT",
      url: `/api/services/${svc.id}`,
      headers: { cookie },
      payload: { name: "Maintenance", unitPriceEuros: 34, isSubscription: true, requestId: REQ },
    });
    expect(res.statusCode).toBe(200);
    const created = stripe.prices.create.mock.calls[0]!;
    expect(created[0]).toEqual({
      product: "prod_1",
      currency: "eur",
      unit_amount: 3_400,
      recurring: { interval: "month" },
      metadata: { erpServiceId: svc.id },
    });
    expect(created[1]).toEqual({ idempotencyKey: `kouzia-service-reprice-${REQ}` });
    const newId = res.json().stripePriceId as string;
    expect(stripe.products.update).toHaveBeenCalledWith("prod_1", { default_price: newId });
    expect(stripe.prices.update).toHaveBeenCalledWith("price_m", { active: false });
    expect(res.json()).toMatchObject({ unitPriceCents: 3_400 });
  });

  it("Stripe refuse : prix ERP inchangé", async () => {
    const svc = await linked();
    stripe.prices.create.mockRejectedValueOnce(new Error("rate limit"));
    const res = await app.inject({
      method: "PUT",
      url: `/api/services/${svc.id}`,
      headers: { cookie },
      payload: { name: "Maintenance", unitPriceEuros: 34, isSubscription: true },
    });
    expect(res.statusCode).toBe(502);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).unitPriceCents).toBe(2_900);
  });

  it("même montant : aucun nouveau prix", async () => {
    const svc = await linked();
    await app.inject({
      method: "PUT",
      url: `/api/services/${svc.id}`,
      headers: { cookie },
      payload: { name: "Maintenance bis", unitPriceEuros: 29, isSubscription: true },
    });
    expect(stripe.prices.create).not.toHaveBeenCalled();
  });

  it("synchro pendant le changement (ancien et nouveau prix actifs) : une seule prestation, au nouveau prix", async () => {
    const svc = await linked();
    stripe.prices.list.mockImplementation(() =>
      listOf([
        stripePrice("price_new", "price_new", { unit_amount: 3_400, metadata: { erpServiceId: svc.id } }),
        stripePrice("price_m", "price_new"),
      ]),
    );
    await syncCatalogFromStripe();
    const all = await prisma.service.findMany();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: svc.id, stripePriceId: "price_new", unitPriceCents: 3_400 });
  });
});

describe("synchro pendant un changement de prix (recette réelle)", () => {
  it("prix par défaut encore l'ancien, nouveau prix lu en premier : pas de prestation pour l'ancien", async () => {
    const svc = await prisma.service.create({
      data: { name: "Maintenance", unitPriceCents: 2_900, isSubscription: true, billingInterval: "MONTH", stripeProductId: "prod_1", stripePriceId: "price_m" },
    });
    stripe.prices.list.mockImplementation(() =>
      listOf([
        stripePrice("price_new", "price_m", { unit_amount: 3_400, created: 200, metadata: { erpServiceId: svc.id } }),
        stripePrice("price_m", "price_m", { created: 100 }),
      ]),
    );
    await syncCatalogFromStripe();
    const all = await prisma.service.findMany();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: svc.id, stripePriceId: "price_new" });
  });

  it("prix plus récent créé ensuite dans le tableau de bord Stripe : importé", async () => {
    const svc = await prisma.service.create({
      data: { name: "Maintenance", unitPriceCents: 3_400, isSubscription: true, billingInterval: "MONTH", stripeProductId: "prod_1", stripePriceId: "price_new" },
    });
    stripe.prices.list.mockImplementation(() =>
      listOf([
        stripePrice("price_dash", "price_dash", { unit_amount: 3_900, created: 300 }),
        stripePrice("price_new", "price_dash", { unit_amount: 3_400, created: 200, metadata: { erpServiceId: svc.id } }),
      ]),
    );
    await syncCatalogFromStripe();
    expect(await prisma.service.count({ where: { stripePriceId: "price_dash" } })).toBe(1);
  });
});

describe("mode Stripe", () => {
  it("prestation créée : mode de la clé enregistré", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/services",
      headers: { cookie },
      payload: { name: "Audit", unitPriceEuros: 300, requestId: REQ },
    });
    expect(res.json()).toMatchObject({ stripeLivemode: false });
  });

  it("prestation live et clé test : changement de prix refusé, aucun prix créé", async () => {
    const svc = await prisma.service.create({
      data: { name: "Site", unitPriceCents: 1_000, stripeProductId: "prod_1", stripePriceId: "price_m", stripeLivemode: true },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/api/services/${svc.id}`,
      headers: { cookie },
      payload: { name: "Site", unitPriceEuros: 20 },
    });
    expect(res.statusCode).toBe(409);
    expect(stripe.prices.create).not.toHaveBeenCalled();
    expect(stripe.products.update).not.toHaveBeenCalled();
  });
});

describe("archiver une prestation liée", () => {
  it("seule prestation du produit : produit archivé dans Stripe", async () => {
    const svc = await prisma.service.create({
      data: { name: "Site", unitPriceCents: 1_000, stripeProductId: "prod_1", stripePriceId: "price_m" },
    });
    const res = await app.inject({ method: "DELETE", url: `/api/services/${svc.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(stripe.products.update).toHaveBeenCalledWith("prod_1", { active: false });
  });

  it("produit partagé (mensuel et annuel) : le prix seul est archivé, le prix par défaut passe à l'autre", async () => {
    const monthly = await prisma.service.create({
      data: { name: "Maintenance", unitPriceCents: 2_900, isSubscription: true, stripeProductId: "prod_1", stripePriceId: "price_m" },
    });
    await prisma.service.create({
      data: { name: "Maintenance (annuel)", unitPriceCents: 29_000, isSubscription: true, stripeProductId: "prod_1", stripePriceId: "price_y" },
    });
    await app.inject({ method: "DELETE", url: `/api/services/${monthly.id}`, headers: { cookie } });
    expect(stripe.products.update).toHaveBeenCalledWith("prod_1", { default_price: "price_y" });
    expect(stripe.prices.update).toHaveBeenCalledWith("price_m", { active: false });
    expect(stripe.products.update).not.toHaveBeenCalledWith("prod_1", { active: false });
  });

  it("Stripe refuse : prestation toujours active", async () => {
    const svc = await prisma.service.create({
      data: { name: "Site", unitPriceCents: 1_000, stripeProductId: "prod_1", stripePriceId: "price_m" },
    });
    stripe.products.update.mockRejectedValueOnce(new Error("boom"));
    const res = await app.inject({ method: "DELETE", url: `/api/services/${svc.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).active).toBe(true);
  });
});
