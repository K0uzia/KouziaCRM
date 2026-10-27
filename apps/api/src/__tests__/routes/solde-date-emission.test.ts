import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 : POST /api/quotes/:id/balance-invoice acceptait une date d'émission quelconque (future, ou
// antérieure à la dernière facture), qui numérotait la facture hors chronologie (F-2027-0001 émise en 2026), et un
// jalon d'un autre devis.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-solde@kouzia.test";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

async function signedQuote(name: string) {
  const client = await createClient({ displayName: name, type: "B2B" });
  const q = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 1200 }] })).json();
  expect((await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  const signed = await call("POST", `/api/quotes/${q.id}/sign-offline`, { signerName: "Léa Martin" });
  expect(signed.statusCode, signed.body).toBe(200);
  return q.id as string;
}

const invoiceCount = () => prisma.invoice.count({ where: { documentType: "INVOICE", number: { not: null } } });

describe("facture de solde : date d'émission et jalon contrôlés", () => {
  it("date d'émission future : refusée, rien de numéroté", async () => {
    const id = await signedQuote("Client Solde Futur");
    const before = await invoiceCount();
    const res = await call("POST", `/api/quotes/${id}/balance-invoice`, { issueDate: "2099-03-01", force: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/futur/);
    expect(await invoiceCount()).toBe(before);
  });

  it("jalon d'un autre devis : refusé", async () => {
    const id = await signedQuote("Client Solde A");
    const other = await signedQuote("Client Solde B");
    await call("GET", `/api/quotes/${other}/market`);
    const foreign = await prisma.paymentMilestone.findFirst({ where: { quoteId: other } });
    expect(foreign).not.toBeNull();
    const before = await invoiceCount();
    const res = await call("POST", `/api/quotes/${id}/balance-invoice`, { milestoneId: foreign!.id, force: true });
    expect(res.statusCode).toBe(404);
    expect(await invoiceCount()).toBe(before);
  });
});
