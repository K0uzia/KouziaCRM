import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
const ADMIN = "admin-flux@kouzia.test";
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

describe("GET /api/stripe/flux", () => {
  it("authentification requise, mois validé", async () => {
    expect((await app.inject({ method: "GET", url: "/api/stripe/flux" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/stripe/flux?month=2026-1", headers: { cookie } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "GET", url: "/api/stripe/flux", headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ months: expect.any(Array), month: expect.any(Object), payouts: [], series: expect.any(Array) });
  });
});
