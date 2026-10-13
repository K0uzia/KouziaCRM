import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
const ADMIN = "admin-retraits@kouzia.test";
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

describe("retraits manuels", () => {
  it("refuse sans session, valide la saisie, crée puis supprime", async () => {
    expect((await app.inject({ method: "GET", url: "/api/owner-pay" })).statusCode).toBe(401);
    // Encaissement du jour : de quoi retirer 500 € (reste net après URSSAF et provisions).
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: { documentType: "INVOICE", invoiceType: "SIMPLE", status: "PAID", clientId: client.id, issueDate: new Date(), subtotalCents: 300000, totalCents: 300000 },
    });
    await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 300000, paidAt: new Date() } });
    const tooMuch = await app.inject({ method: "POST", url: "/api/owner-withdrawals", headers: { cookie }, payload: { amountCents: 10_000_000, date: "2026-10-02" } });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error.fieldErrors.amountCents[0]).toMatch(/^Au plus .* disponibles$/);
    const bad = await app.inject({ method: "POST", url: "/api/owner-withdrawals", headers: { cookie }, payload: { amountCents: 0, date: "13/10/2026" } });
    expect(bad.statusCode).toBe(400);
    const created = await app.inject({
      method: "POST",
      url: "/api/owner-withdrawals",
      headers: { cookie },
      payload: { amountCents: 50000, date: "2026-10-02", note: "Virement vers le compte perso" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const summary = await app.inject({ method: "GET", url: "/api/owner-pay", headers: { cookie } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().withdrawals[0]).toMatchObject({ id, amountCents: 50000, note: "Virement vers le compte perso" });
    expect(summary.json().paidThisMonthCents).toBeGreaterThanOrEqual(0);
    const fixed = await app.inject({
      method: "PATCH",
      url: `/api/owner-withdrawals/${id}`,
      headers: { cookie },
      payload: { amountCents: 45000, date: "2026-10-03", note: null },
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json()).toMatchObject({ amountCents: 45000, note: null });
    expect((await app.inject({ method: "DELETE", url: `/api/owner-withdrawals/${id}`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/owner-withdrawals/${id}`, headers: { cookie } })).statusCode).toBe(404);
  });
});
