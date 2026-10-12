import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const productsUpdate = vi.fn(async () => ({}));
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => ({ products: { update: productsUpdate } })),
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
  productsUpdate.mockClear();
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
