import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Remise d'un devis récurrent par l'API (R1) : création, modification, aperçu ; messages pour l'écran.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-remise@kouzia.test";
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

const call = (method: "POST" | "PUT", url: string, payload: unknown) => app.inject({ method, url, payload: payload as never, headers: { cookie } });
async function body(commitmentMonths: number, extra: Record<string, unknown> = {}) {
  const client = await createClient({ displayName: "Client Remise" });
  const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
  return {
    clientId: client.id,
    documentType: "QUOTE",
    billingMode: "RECURRING",
    lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc.id, commitmentMonths }],
    ...extra,
  };
}

describe("remise d'un devis récurrent (API)", () => {
  it("remise d'ouverture : enregistrée avec 36 mois ; refusée sinon, avec un message clair", async () => {
    const ok = await call("POST", "/api/invoices", await body(36, { openingDiscount: true }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ openingDiscount: true, recurringDiscountKind: "PERCENT", recurringDiscountValue: 3000, recurringDiscountMonths: 12 });
    const refused = await call("POST", "/api/invoices", await body(24, { openingDiscount: true }));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("Remise d'ouverture : seulement avec l'engagement de 36 mois. Choisissez 36 mois, ou retirez la remise d'ouverture.");
    const both = await call("POST", "/api/invoices", await body(36, { openingDiscount: true, recurringDiscount: { kind: "PERCENT", percent: 10 } }));
    expect(both.statusCode).toBe(400);
    expect(both.json().error).toMatch(/ne se cumulent pas/);
  });

  it("modification : engagement réduit sous 36 mois refusé ; passage en paiement unique : remise retirée", async () => {
    const created = (await call("POST", "/api/invoices", await body(36, { openingDiscount: true }))).json();
    const lines = (await body(24)).lines;
    const shorter = await call("PUT", `/api/invoices/${created.id}`, { lines });
    expect(shorter.statusCode).toBe(400);
    expect(shorter.json().error).toMatch(/seulement avec l'engagement de 36 mois/);
    const manual = await call("PUT", `/api/invoices/${created.id}`, { openingDiscount: false, recurringDiscount: { kind: "FIXED", euros: 200, months: 24 } });
    expect(manual.statusCode, manual.body).toBe(200);
    expect(manual.json()).toMatchObject({ openingDiscount: false, recurringDiscountKind: "FIXED", recurringDiscountValue: 20000, recurringDiscountMonths: 24 });
    const oneOff = await call("PUT", `/api/invoices/${created.id}`, { billingMode: "ONE_OFF", lines: [{ description: "Site vitrine", quantity: 1, unitPriceEuros: 1500 }] });
    expect(oneOff.statusCode, oneOff.body).toBe(200);
    expect(oneOff.json()).toMatchObject({ openingDiscount: false, recurringDiscountKind: null, recurringDiscountValue: null, recurringDiscountMonths: null });
  });

  it("aperçu du brouillon : 200 avec la remise, 400 si elle n'est pas permise", async () => {
    expect((await call("POST", "/api/invoices/preview.pdf", await body(36, { openingDiscount: true }))).statusCode).toBe(200);
    expect((await call("POST", "/api/invoices/preview.pdf", await body(12, { openingDiscount: true }))).statusCode).toBe(400);
  }, 30_000);
});
