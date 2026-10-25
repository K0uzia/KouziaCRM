import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Devis à 2 propositions (P1, 27/10/2026) : modèle et éditeur ; émission refusée tant que la signature manque (P3).
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-propositions@kouzia.test";
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

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

const oneOff = (extra: Record<string, unknown> = {}) => ({
  label: "Paiement unique",
  billingMode: "ONE_OFF",
  lines: [
    { description: "Création du site", quantity: 1, unitPriceEuros: 2000 },
    { description: "Rédaction", quantity: 2, unitPriceEuros: 150 },
  ],
  ...extra,
});
const recurring = (serviceId: string, extra: Record<string, unknown> = {}) => ({
  label: "Annuel avec engagement 3 ans",
  billingMode: "RECURRING",
  lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId, commitmentMonths: 36 }],
  ...extra,
});

async function setup() {
  const client = await createClient({ displayName: "Client Propositions" });
  const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
  return { clientId: client.id, serviceId: svc.id };
}

describe("devis à 2 propositions (P1)", () => {
  it("création : 2 propositions complètes, lignes rattachées, totaux de la moins chère, facturation neutre", async () => {
    const { clientId, serviceId } = await setup();
    const res = await call("POST", "/api/invoices", {
      clientId,
      documentType: "QUOTE",
      notes: "Deux formules",
      options: [oneOff(), recurring(serviceId, { openingDiscount: true })],
    });
    expect(res.statusCode, res.body).toBe(201);
    const q = res.json();
    expect(q).toMatchObject({ billingMode: null, paymentPlanOffer: null, openingDiscount: false, promoCodeId: null, totalCents: 150000, quoteStatus: "DRAFT", number: null });
    expect(q.options).toHaveLength(2);
    const [a, b] = q.options;
    expect(a).toMatchObject({ position: 0, label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "TWO", totalCents: 230000 });
    expect(b).toMatchObject({ position: 1, billingMode: "RECURRING", paymentPlanOffer: "NONE", openingDiscount: true, recurringDiscountKind: "PERCENT", recurringDiscountValue: 3000, totalCents: 150000 });
    expect(q.lines.map((l: { position: number; optionId: string }) => [l.position, l.optionId])).toEqual([
      [1, a.id],
      [2, a.id],
      [3, b.id],
    ]);
    // Relecture : mêmes propositions, dans l'ordre.
    const read = (await call("GET", `/api/invoices/${q.id}`)).json();
    expect(read.options.map((o: { label: string }) => o.label)).toEqual(["Paiement unique", "Annuel avec engagement 3 ans"]);
  });

  it("validation : 2 propositions exactement, pas de lignes à côté, devis seulement, chaque proposition vérifiée", async () => {
    const { clientId, serviceId } = await setup();
    const base = { clientId, documentType: "QUOTE" };
    expect((await call("POST", "/api/invoices", { ...base, options: [oneOff()] })).statusCode).toBe(400);
    expect((await call("POST", "/api/invoices", { ...base, options: [oneOff(), oneOff(), oneOff()] })).statusCode).toBe(400);
    expect((await call("POST", "/api/invoices", { ...base, options: [oneOff(), oneOff()], lines: oneOff().lines })).statusCode).toBe(400);
    expect((await call("POST", "/api/invoices", { clientId, documentType: "INVOICE", options: [oneOff(), oneOff()] })).statusCode).toBe(400);
    const noCommitment = recurring(serviceId);
    (noCommitment.lines[0] as Record<string, unknown>).commitmentMonths = null;
    const bad = await call("POST", "/api/invoices", { ...base, options: [oneOff(), noCommitment] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBeTruthy();
    expect(await prisma.invoice.count()).toBe(0);
  });

  it("modification : propositions remplacées, réglages du devis refusés, retour au devis simple", async () => {
    const { clientId, serviceId } = await setup();
    const q = (await call("POST", "/api/invoices", { clientId, documentType: "QUOTE", options: [oneOff(), recurring(serviceId)] })).json();

    const put = await call("PUT", `/api/invoices/${q.id}`, { options: [oneOff({ label: "Tout de suite", lines: [{ description: "Création", quantity: 1, unitPriceEuros: 900 }] }), recurring(serviceId)] });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json().options.map((o: { label: string }) => o.label)).toEqual(["Tout de suite", "Annuel avec engagement 3 ans"]);
    expect(put.json()).toMatchObject({ totalCents: 90000 });
    expect(await prisma.invoiceLine.count({ where: { invoiceId: q.id } })).toBe(2);
    expect(await prisma.quoteOption.count({ where: { quoteId: q.id } })).toBe(2);

    expect((await call("PUT", `/api/invoices/${q.id}`, { billingMode: "ONE_OFF" })).statusCode).toBe(400);
    expect((await call("PUT", `/api/invoices/${q.id}`, { options: null })).statusCode).toBe(400);

    const simple = await call("PUT", `/api/invoices/${q.id}`, { options: null, billingMode: "ONE_OFF", lines: oneOff().lines });
    expect(simple.statusCode, simple.body).toBe(200);
    expect(simple.json()).toMatchObject({ billingMode: "ONE_OFF", totalCents: 230000, options: [] });
    expect(simple.json().lines.every((l: { optionId: string | null }) => l.optionId === null)).toBe(true);
  });

  it("émission refusée tant que la signature d'une proposition manque ; aperçu rendu (P2)", async () => {
    const { clientId, serviceId } = await setup();
    const body = { clientId, documentType: "QUOTE", options: [oneOff(), recurring(serviceId)] };
    const q = (await call("POST", "/api/invoices", body)).json();
    const issue = await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } });
    expect(issue.statusCode).toBe(400);
    expect(issue.json().error).toMatch(/2 propositions/);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ status: "DRAFT", number: null });
    const preview = await call("POST", "/api/invoices/preview.pdf", body);
    expect(preview.statusCode, preview.body).toBe(200);
  });

  it("code promo sur une proposition : compté dès l'émission, libéré si une autre proposition est retenue", async () => {
    const { clientId, serviceId } = await setup();
    await call("POST", "/api/promo-codes", { code: "OUVERTURE30", kind: "PERCENT", percent: 30, months: 12 });
    const q = (await call("POST", "/api/invoices", { clientId, documentType: "QUOTE", options: [oneOff(), recurring(serviceId, { promoCode: "ouverture30" })] })).json();
    expect(q.options[1]).toMatchObject({ recurringDiscountValue: 3000, promoCode: { code: "OUVERTURE30" } });

    // Émission simulée (P2 et P3 à venir) : le code compte pour ce client.
    await prisma.invoice.update({ where: { id: q.id }, data: { number: "D-2026-0001", status: "ISSUED", quoteStatus: "SENT" } });
    const again = await call("POST", "/api/invoices", { clientId, documentType: "QUOTE", options: [oneOff(), recurring(serviceId, { promoCode: "OUVERTURE30" })] });
    expect(again.json().error).toBe("Code promo OUVERTURE30 : déjà utilisé par ce client.");

    // Signature simulée de la proposition A (sans code) : le code est libéré.
    await prisma.invoice.update({ where: { id: q.id }, data: { quoteStatus: "ACCEPTED", selectedOptionId: q.options[0].id } });
    const freed = await call("POST", "/api/invoices", { clientId, documentType: "QUOTE", options: [oneOff(), recurring(serviceId, { promoCode: "OUVERTURE30" })] });
    expect(freed.statusCode, freed.body).toBe(201);
  });
});
