import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { buildApp } from "@/app.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const ADMIN = "admin-recherche@kouzia.test";
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
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

describe("recherche (palette Ctrl K)", () => {
  it("une offre d'abonnement porte sa périodicité : « / an » affiché pour une annuelle", async () => {
    await prisma.service.create({
      data: { name: "Hébergement annuel", unitPriceCents: 12_000, unit: "FORFAIT", active: true, isSubscription: true, billingInterval: "YEAR" },
    });
    const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent("Hébergement")}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().services).toEqual([expect.objectContaining({ name: "Hébergement annuel", isSubscription: true, billingInterval: "YEAR" })]);
  });
});
