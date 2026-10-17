import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const productsUpdate = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
const productsRetrieve = vi.fn(async (): Promise<unknown> => ({ default_price: "price_1" }));
const pricesCreate = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ id: "price_2" }));
const pricesUpdate = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => ({
    products: { update: productsUpdate, retrieve: productsRetrieve },
    prices: { create: pricesCreate, update: pricesUpdate },
  })),
  // Clé de test explicite : le mode de la clé est lu avant toute écriture vers Stripe.
  getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_x", webhookSecret: null, mode: "test", enabled: true })),
}));

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-prestations@kouzia.test";
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
  for (const m of [productsUpdate, productsRetrieve, pricesCreate, pricesUpdate]) m.mockReset();
  productsUpdate.mockImplementation(async () => ({}));
  productsRetrieve.mockImplementation(async () => ({ default_price: "price_1" }));
  pricesCreate.mockImplementation(async () => ({ id: "price_2" }));
  pricesUpdate.mockImplementation(async () => ({}));
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

describe("prestation liée à Stripe", () => {
  it("nom et description modifiables et repoussés vers Stripe ; même prix : aucun nouveau prix", async () => {
    const svc = await prisma.service.create({
      data: { name: "Site vitrine", unitPriceCents: 129_000, unit: "FORFAIT", active: true, stripeProductId: "prod_1", stripePriceId: "price_1" },
    });
    const res = await app.inject({
      method: "PUT",
      url: `/api/services/${svc.id}`,
      headers: { cookie },
      payload: { name: "Site vitrine (5 pages)", description: "Jusqu'à 5 pages", unitPriceEuros: 1290 },
    });
    expect(res.statusCode).toBe(200);
    expect(productsUpdate).toHaveBeenCalledWith("prod_1", { name: "Site vitrine (5 pages)", description: "Jusqu'à 5 pages" });
    const after = await prisma.service.findUniqueOrThrow({ where: { id: svc.id } });
    expect(after).toMatchObject({ name: "Site vitrine (5 pages)", unitPriceCents: 129_000 });
  });

  it("prestation non liée : modification complète, sans appel à Stripe", async () => {
    const svc = await prisma.service.create({ data: { name: "Atelier", unitPriceCents: 39_000, unit: "FORFAIT", active: true } });
    const res = await app.inject({
      method: "PUT",
      url: `/api/services/${svc.id}`,
      headers: { cookie },
      payload: { name: "Atelier", unitPriceEuros: 420 },
    });
    expect(res.statusCode).toBe(200);
    expect(productsUpdate).not.toHaveBeenCalled();
    expect((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).unitPriceCents).toBe(42_000);
  });
});

describe("offre d'abonnement liée : Stripe en échec, rien d'appliqué à moitié", () => {
  const offre = () =>
    prisma.service.create({
      data: {
        name: "Maintenance",
        description: "Mises à jour",
        unitPriceCents: 3_000,
        unit: "FORFAIT",
        active: true,
        isSubscription: true,
        billingInterval: "MONTH",
        stripeProductId: "prod_1",
        stripePriceId: "price_1",
      },
    });
  const payload = { name: "Maintenance plus", description: "Mises à jour et sauvegardes", unitPriceEuros: 30, isSubscription: true, defaultBillingDay: 1 };

  it("Stripe refuse le nom : 502 clair, offre inchangée dans l'ERP", async () => {
    const svc = await offre();
    productsUpdate.mockRejectedValueOnce(new Error("Stripe indisponible"));
    const res = await app.inject({ method: "PUT", url: `/api/services/${svc.id}`, headers: { cookie }, payload });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/Stripe n'a pas accepté la modification/);
    expect(await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).toMatchObject({ name: "Maintenance", unitPriceCents: 3_000, stripePriceId: "price_1" });
  });

  it("Stripe refuse le nouveau prix : 502, nom Stripe rétabli, offre inchangée dans l'ERP", async () => {
    const svc = await offre();
    pricesCreate.mockRejectedValueOnce(new Error("montant refusé"));
    const res = await app.inject({ method: "PUT", url: `/api/services/${svc.id}`, headers: { cookie }, payload: { ...payload, unitPriceEuros: 35 } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/garde son prix actuel/);
    expect(productsUpdate).toHaveBeenLastCalledWith("prod_1", { name: "Maintenance", description: "Mises à jour" });
    expect(await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).toMatchObject({ name: "Maintenance", unitPriceCents: 3_000, stripePriceId: "price_1" });
  });

  it("nom non rétabli dans Stripe : le message le dit", async () => {
    const svc = await offre();
    pricesCreate.mockRejectedValueOnce(new Error("montant refusé"));
    productsUpdate.mockImplementationOnce(async () => ({})).mockRejectedValueOnce(new Error("réseau"));
    const res = await app.inject({ method: "PUT", url: `/api/services/${svc.id}`, headers: { cookie }, payload: { ...payload, unitPriceEuros: 35 } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/nouveau nom est resté dans Stripe/);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).name).toBe("Maintenance");
  });

  it("archivage refusé par Stripe : 502, offre toujours active", async () => {
    const svc = await offre();
    productsUpdate.mockRejectedValueOnce(new Error("Stripe indisponible"));
    const res = await app.inject({ method: "DELETE", url: `/api/services/${svc.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/elle reste active/);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).active).toBe(true);
  });

  it("nouveau prix accepté : nouveau prix Stripe, contrats en cours inchangés", async () => {
    const svc = await offre();
    const client = await prisma.client.create({ data: { displayName: "Client", type: "B2B" } });
    const sub = await prisma.subscription.create({
      data: { clientId: client.id, serviceId: svc.id, label: "Maintenance", amountCents: 3_000, billingDay: 1, startDate: new Date(), nextInvoiceAt: new Date() },
    });
    const res = await app.inject({ method: "PUT", url: `/api/services/${svc.id}`, headers: { cookie }, payload: { ...payload, unitPriceEuros: 35 } });
    expect(res.statusCode).toBe(200);
    expect(await prisma.service.findUniqueOrThrow({ where: { id: svc.id } })).toMatchObject({ unitPriceCents: 3_500, stripePriceId: "price_2" });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).amountCents).toBe(3_000);
  });
});
