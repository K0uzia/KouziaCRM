import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Codes promo (R3, 26/10/2026) : écran Offre, application à un devis récurrent, règles, PDF, /suivi.
const { buildApp } = await import("@/app.js");
const { issueQuote } = await import("@/lib/invoices/transitions.js");
const { loadDocumentForPdf, pdfDataOfLoaded } = await import("@/lib/pdf/document-pdf.js");
const { readableInvoice } = await import("@/lib/pdf/readable-documents.js");

const ADMIN = "admin-promo@kouzia.test";
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

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

async function quoteBody(extra: Record<string, unknown> = {}, clientId?: string, serviceId?: string) {
  const client = clientId ?? (await createClient({ displayName: "Client Promo" })).id;
  const svc = serviceId ?? (await createService({ name: "Site tout compris", unitPriceCents: 150000 })).id;
  return {
    clientId: client,
    documentType: "QUOTE",
    billingMode: "RECURRING",
    lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc, commitmentMonths: 36 }],
    ...extra,
  };
}

describe("codes promo (écran Offre)", () => {
  it("réservé à l'administrateur ; création normalisée, code unique, montant requis", async () => {
    expect((await app.inject({ method: "GET", url: "/api/promo-codes" })).statusCode).toBe(401);
    const created = await call("POST", "/api/promo-codes", { code: " ouverture30 ", kind: "PERCENT", percent: 30, months: 12, conditionText: "structure créée il y a moins de 12 mois" });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ code: "OUVERTURE30", kind: "PERCENT", value: 3000, months: 12, uses: 0, state: "ACTIVE" });
    expect((await call("POST", "/api/promo-codes", { code: "OUVERTURE30", kind: "PERCENT", percent: 10 })).statusCode).toBe(409);
    expect((await call("POST", "/api/promo-codes", { code: "a b", kind: "PERCENT", percent: 10 })).statusCode).toBe(400);
    expect((await call("POST", "/api/promo-codes", { code: "SANSMONTANT", kind: "FIXED" })).statusCode).toBe(400);
  });

  it("appliqué à un devis : remise du code, figée ; pas de cumul ; un usage par client ; plafond d'usages", async () => {
    const code = (await call("POST", "/api/promo-codes", { code: "BIENVENUE", kind: "FIXED", euros: 200, months: 24, maxUses: 2, conditionText: "nouveau client" })).json();
    const body = await quoteBody({ promoCode: "bienvenue" });
    const q = await call("POST", "/api/invoices", body);
    expect(q.statusCode, q.body).toBe(201);
    expect(q.json()).toMatchObject({ promoCodeId: code.id, recurringDiscountKind: "FIXED", recurringDiscountValue: 20000, recurringDiscountMonths: 24, openingDiscount: false });
    expect((await call("POST", "/api/invoices", await quoteBody({ promoCode: "BIENVENUE", openingDiscount: true }))).json().error).toMatch(/ne se cumulent pas/);
    expect((await call("POST", "/api/invoices", await quoteBody({ promoCode: "INCONNU" }))).json().error).toBe("Code promo inconnu.");

    await issueQuote(q.json().id);
    // Même client : déjà utilisé ; autre client : accepté puis plafond atteint.
    const again = await call("POST", "/api/invoices", await quoteBody({ promoCode: "BIENVENUE" }, body.clientId, body.lines[0]!.serviceId));
    expect(again.json().error).toBe("Code promo BIENVENUE : déjà utilisé par ce client.");
    const second = await call("POST", "/api/invoices", await quoteBody({ promoCode: "BIENVENUE" }));
    expect(second.statusCode).toBe(201);
    await issueQuote(second.json().id);
    expect((await call("POST", "/api/invoices", await quoteBody({ promoCode: "BIENVENUE" }))).json().error).toBe("Code promo BIENVENUE : plus d'utilisation disponible.");
    expect((await call("GET", "/api/promo-codes")).json().codes[0]).toMatchObject({ code: "BIENVENUE", uses: 2, state: "EXHAUSTED" });

    // Code modifié ensuite : le devis émis garde sa remise ; suppression refusée, désactivation possible.
    await call("PUT", `/api/promo-codes/${code.id}`, { kind: "FIXED", euros: 500, maxUses: 2 });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.json().id } })).recurringDiscountValue).toBe(20000);
    expect((await call("DELETE", `/api/promo-codes/${code.id}`)).statusCode).toBe(409);
  });

  it("offres concernées, validité et code désactivé ; codes disponibles pour un devis", async () => {
    const svc = await createService({ name: "Boutique", unitPriceCents: 290000 });
    const other = await createService({ name: "Site vitrine", unitPriceCents: 150000 });
    await call("POST", "/api/promo-codes", { code: "BOUTIQUE10", kind: "PERCENT", percent: 10, serviceIds: [svc.id] });
    await call("POST", "/api/promo-codes", { code: "PASSE", kind: "PERCENT", percent: 10, validUntil: "2020-01-01" });
    expect((await call("POST", "/api/invoices", await quoteBody({ promoCode: "BOUTIQUE10" }, undefined, other.id))).json().error).toMatch(/ne s'applique pas à l'offre/);
    expect((await call("POST", "/api/invoices", await quoteBody({ promoCode: "PASSE" }))).json().error).toBe("Code promo PASSE : expiré.");
    const client = await createClient({ displayName: "Client Dispo" });
    const available = (await call("GET", `/api/promo-codes/available?clientId=${client.id}&serviceIds=${svc.id}`)).json().codes.map((c: { code: string }) => c.code);
    expect(available).toEqual(["BOUTIQUE10"]);
  });

  it("PDF et /suivi : « Code promo X », condition imprimée", async () => {
    await call("POST", "/api/promo-codes", { code: "OUVERTURE30", kind: "PERCENT", percent: 30, months: 12, conditionText: "structure créée il y a moins de 12 mois" });
    const q = (await call("POST", "/api/invoices", await quoteBody({ promoCode: "OUVERTURE30" }))).json();
    await issueQuote(q.id);
    const doc = JSON.stringify(readableInvoice(await pdfDataOfLoaded((await loadDocumentForPdf(q.id))!), "LIVE").doc).replace(/[  ]/g, " ");
    expect(doc).toContain("Code promo OUVERTURE30 : 30 % sur la 1re échéance");
    expect(doc).toContain("Code promo OUVERTURE30 : 30 % sur la 1re échéance, soit 1 050,00 € la 1re année, puis 1 500,00 € par an.");
    expect(doc).toContain("Code promo OUVERTURE30 : structure créée il y a moins de 12 mois.");
  });
});
