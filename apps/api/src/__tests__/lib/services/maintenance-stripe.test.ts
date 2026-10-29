import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
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
    create: vi.fn(async (_p: unknown, _o?: unknown) => ({ id: `prod_${++seq}` })),
    update: vi.fn(async (_id: string, _p: unknown) => ({})),
    retrieve: vi.fn(async (_id: string) => ({ id: "prod_1", default_price: null })),
  },
  prices: {
    create: vi.fn(async (_p: unknown, _o?: unknown) => ({ id: `price_${++seq}` })),
    update: vi.fn(async (_id: string, _p: unknown) => ({})),
    list: vi.fn((_p?: unknown) => listOf([] as Stripe.Price[])),
  },
};
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => stripe),
  getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_x", webhookSecret: null, mode: "test", enabled: true })),
}));

const { ensureMaintenanceOffers, linkBootServicesToStripe, MAINTENANCE_PACK_ID, MAINTENANCE_SITE_ID } = await import(
  "@/lib/services/maintenance-offers.js"
);
const { createLinkedService } = await import("@/lib/stripe/catalog-write.js");
const { syncCatalogFromStripe } = await import("@/lib/stripe/catalog.js");
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-maintenance-stripe@kouzia.test";
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});

async function stripeOn(on = true, key = true) {
  await prisma.companySettings.updateMany({
    data: { moduleStripeEnabled: on, stripeSecretKeyEncrypted: key ? encrypt("sk_test_fake") : null },
  });
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  for (const group of [stripe.products, stripe.prices]) for (const fn of Object.values(group)) fn.mockReset();
  stripe.products.create.mockImplementation(async () => ({ id: `prod_${++seq}` }));
  stripe.products.update.mockImplementation(async () => ({}));
  stripe.prices.create.mockImplementation(async () => ({ id: `price_${++seq}` }));
  stripe.prices.list.mockImplementation(() => listOf([] as Stripe.Price[]));
  const user = await prisma.user.upsert({ where: { email: ADMIN }, update: {}, create: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

describe("maintenances créées au démarrage : liées à Stripe comme depuis Prestations", () => {
  it("Stripe inactif ou clé absente : rien n'est fait (nouvel essai au prochain démarrage)", async () => {
    await ensureMaintenanceOffers();
    await stripeOn(false, true);
    expect(await linkBootServicesToStripe()).toEqual([]);
    await stripeOn(true, false);
    expect(await linkBootServicesToStripe()).toEqual([]);
    expect(stripe.products.create).not.toHaveBeenCalled();
    expect(await prisma.service.count({ where: { stripeProductId: { not: null } } })).toBe(0);
  });

  it("Stripe actif : produit et prix annuel créés, identifiants gardés, une seule fois", async () => {
    await ensureMaintenanceOffers();
    await stripeOn();
    const log = await linkBootServicesToStripe();
    expect(log).toHaveLength(2);
    expect(log.join("\n")).toContain("liée à Stripe (test)");

    const site = await prisma.service.findUniqueOrThrow({ where: { id: MAINTENANCE_SITE_ID } });
    const pack = await prisma.service.findUniqueOrThrow({ where: { id: MAINTENANCE_PACK_ID } });
    // Même nom que la synchro horaire donne à une offre annuelle : elle ne le réécrit pas ensuite.
    expect(site).toMatchObject({ name: "Maintenance site (annuel)", unitPriceCents: 35000, billingInterval: "YEAR", stripeLivemode: false, active: true });
    expect(pack).toMatchObject({ name: "Maintenance site (pack) (annuel)", unitPriceCents: 19700, billingInterval: "YEAR", stripeLivemode: false });
    expect(site.stripeProductId).toBeTruthy();
    expect(site.stripePriceId).toBeTruthy();

    const productFor = (name: string) => stripe.products.create.mock.calls.find((c) => (c[0] as { name: string }).name === name)!;
    expect(productFor("Maintenance site")[0]).toEqual({ name: "Maintenance site", description: site.description, metadata: { source: "kouzia-erp" } });
    expect(productFor("Maintenance site (pack)")[0]).toMatchObject({ metadata: { source: "kouzia-erp" } });
    expect(stripe.prices.create).toHaveBeenCalledWith(
      { product: site.stripeProductId, currency: "eur", unit_amount: 35000, recurring: { interval: "year" } },
      { idempotencyKey: `kouzia-service-price-boot-${MAINTENANCE_SITE_ID}` },
    );

    // Deuxième démarrage : déjà liées, rien n'est appelé.
    stripe.products.create.mockClear();
    expect(await linkBootServicesToStripe()).toEqual([]);
    expect(stripe.products.create).not.toHaveBeenCalled();
  });

  it("mêmes appels Stripe qu'une prestation annuelle créée depuis l'écran", async () => {
    await ensureMaintenanceOffers();
    await stripeOn();
    await linkBootServicesToStripe();
    const boot = stripe.products.create.mock.calls.find((c) => (c[0] as { name: string }).name === "Maintenance site")!;
    const bootPrice = stripe.prices.create.mock.calls.find((c) => (c[0] as { unit_amount: number }).unit_amount === 35000)!;
    stripe.products.create.mockClear();
    stripe.prices.create.mockClear();
    const ui = await createLinkedService({
      name: "Maintenance site",
      description: (await prisma.service.findUniqueOrThrow({ where: { id: MAINTENANCE_SITE_ID } })).description,
      unitPriceCents: 35000,
      isSubscription: true,
      billingInterval: "YEAR",
      defaultBillingDay: 1,
      requestId: "ui",
    });
    expect(stripe.products.create.mock.calls[0]![0]).toEqual(boot[0]);
    const { product: _p1, ...uiPrice } = stripe.prices.create.mock.calls[0]![0] as Record<string, unknown>;
    const { product: _p2, ...bootPriceBody } = bootPrice[0] as Record<string, unknown>;
    expect(uiPrice).toEqual(bootPriceBody);
    expect(ui.name).toBe("Maintenance site (annuel)");
  });

  it("Stripe refuse : prestation inchangée, journal clair, liée au démarrage suivant", async () => {
    await ensureMaintenanceOffers();
    await stripeOn();
    stripe.products.create.mockRejectedValue(new Error("réseau indisponible"));
    const log = await linkBootServicesToStripe();
    expect(log.join("\n")).toContain("nouvel essai au prochain démarrage");
    const site = await prisma.service.findUniqueOrThrow({ where: { id: MAINTENANCE_SITE_ID } });
    expect(site).toMatchObject({ name: "Maintenance site", stripeProductId: null, stripePriceId: null });

    stripe.products.create.mockImplementation(async () => ({ id: `prod_${++seq}` }));
    expect(await linkBootServicesToStripe()).toHaveLength(2);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: MAINTENANCE_SITE_ID } })).stripePriceId).toBeTruthy();
  });

  it("maintenance archivée ou déjà liée : laissée telle quelle ; packs toujours reliés à la maintenance pack", async () => {
    await ensureMaintenanceOffers();
    await stripeOn();
    await prisma.service.update({ where: { id: MAINTENANCE_SITE_ID }, data: { active: false } });
    await prisma.service.update({ where: { id: MAINTENANCE_PACK_ID }, data: { stripeProductId: "prod_deja", stripePriceId: "price_deja" } });
    expect(await linkBootServicesToStripe()).toEqual([]);
    expect(stripe.products.create).not.toHaveBeenCalled();
  });

  it("prestation créée entre-temps par le webhook pour ce prix : doublon retiré, la maintenance garde son identifiant", async () => {
    await ensureMaintenanceOffers();
    await stripeOn();
    await prisma.service.update({ where: { id: MAINTENANCE_PACK_ID }, data: { active: false } });
    stripe.prices.create.mockImplementation(async () => {
      await prisma.service.create({ data: { name: "Maintenance site (annuel)", unitPriceCents: 35000, isSubscription: true, billingInterval: "YEAR", stripePriceId: "price_webhook", stripeProductId: "prod_w" } });
      return { id: "price_webhook" };
    });
    await linkBootServicesToStripe();
    const all = await prisma.service.findMany({ where: { stripePriceId: "price_webhook" } });
    expect(all.map((s) => s.id)).toEqual([MAINTENANCE_SITE_ID]);
  });

  it("synchro horaire ensuite : rien à réécrire (nom, prix, périodicité identiques)", async () => {
    await ensureMaintenanceOffers();
    await stripeOn();
    await prisma.service.update({ where: { id: MAINTENANCE_PACK_ID }, data: { active: false } });
    await linkBootServicesToStripe();
    const site = await prisma.service.findUniqueOrThrow({ where: { id: MAINTENANCE_SITE_ID } });
    stripe.prices.list.mockImplementation(() =>
      listOf([
        {
          id: site.stripePriceId,
          currency: "eur",
          unit_amount: 35000,
          type: "recurring",
          recurring: { interval: "year" },
          livemode: false,
          metadata: {},
          product: { id: site.stripeProductId, active: true, name: "Maintenance site", description: site.description, default_price: site.stripePriceId },
        } as unknown as Stripe.Price,
      ]),
    );
    const actions = await syncCatalogFromStripe();
    expect(actions.find((a) => a.stripePriceId === site.stripePriceId)?.action).toBe("same");
  });
});

describe("archiver une offre d'abonnement (Abonnements, bouton Archiver)", () => {
  it("?archive=1 : jamais supprimée, même inutilisée ; produit Stripe archivé", async () => {
    await stripeOn();
    const offer = await prisma.service.create({
      data: { name: "Hébergement (annuel)", unitPriceCents: 12000, isSubscription: true, billingInterval: "YEAR", stripeProductId: "prod_h", stripePriceId: "price_h", stripeLivemode: false },
    });
    const res = await app.inject({ method: "DELETE", url: `/api/services/${offer.id}?archive=1`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, archived: true });
    expect((await prisma.service.findUniqueOrThrow({ where: { id: offer.id } })).active).toBe(false);
    expect(stripe.products.update).toHaveBeenCalledWith("prod_h", { active: false });
  });

  it("sans ?archive=1 : une prestation inutilisée est supprimée (comportement de Prestations inchangé)", async () => {
    const svc = await prisma.service.create({ data: { name: "Atelier", unitPriceCents: 10000 } });
    const res = await app.inject({ method: "DELETE", url: `/api/services/${svc.id}`, headers: { cookie } });
    expect(res.json()).toMatchObject({ ok: true, archived: false });
    expect(await prisma.service.findUnique({ where: { id: svc.id } })).toBeNull();
  });
});
