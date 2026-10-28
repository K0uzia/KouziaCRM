import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { BILLABLE_LINES_WHERE } from "@/lib/quotes/quote-options.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Signature d'un devis en paiement unique avec maintenance en option (décisions du 28/10/2026) : choix explicite du
// client, preuve figée, totaux, et abonnement démarré à la livraison avec un engagement compté depuis ce départ.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

const { buildApp } = await import("@/app.js");

const EMAIL = "camille-option@exemple.fr";
const ADMIN = "admin-option-signature@kouzia.test";
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

const site = { description: "Création du site vitrine", quantity: 1, unitPriceEuros: 1200 };
const optionLine = (serviceId: string) => ({
  description: "Maintenance annuelle",
  quantity: 1,
  unitPriceEuros: 300,
  isSubscription: true,
  isOptional: true,
  billingInterval: "YEAR",
  billingDay: 1,
  serviceId,
  commitmentMonths: 24,
});

async function issuedQuote() {
  const client = await createClient({ displayName: "Atelier Camille", type: "B2B" });
  await prisma.client.update({
    where: { id: client.id },
    data: { companyName: "Atelier Camille", lastName: "Cliente", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) },
  });
  const svc = await createService({ name: "Maintenance annuelle", unitPriceCents: 30000 });
  const res = await call("POST", "/api/invoices", {
    clientId: client.id,
    documentType: "QUOTE",
    billingMode: "ONE_OFF",
    paymentPlanOffer: "TWO",
    lines: [site, optionLine(svc.id)],
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  expect((await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  const optional = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: id, isOptional: true } });
  return { id, lineId: optional.id, clientId: client.id };
}

const signOffline = (id: string, extra: Record<string, unknown> = {}) => call("POST", `/api/quotes/${id}/sign-offline`, { signerName: "Camille Cliente", ...extra });

describe("signature hors ligne : choix de l'option obligatoire", () => {
  it("sans choix, avec une ligne inconnue ou un doublon : 400, devis toujours en attente", async () => {
    const { id, lineId } = await issuedQuote();
    const missing = await signOffline(id);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("OPTIONAL_CHOICE_REQUIRED");
    const unknown = await signOffline(id, { optionalLines: [{ id: lineId, accepted: true }, { id: "inconnue", accepted: true }] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().code).toBe("OPTIONAL_CHOICE_INVALID");
    const twice = await signOffline(id, { optionalLines: [{ id: lineId, accepted: true }, { id: lineId, accepted: false }] });
    expect(twice.statusCode).toBe(400);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).quoteStatus).toBe("SENT");
  });

  it("option retenue : total avec la 1re année, acompte sans elle, preuve figée ; abonnement à la livraison, engagement depuis ce départ", async () => {
    const { id, lineId } = await issuedQuote();
    const res = await signOffline(id, { optionalLines: [{ id: lineId, accepted: true }] });
    expect(res.statusCode, res.body).toBe(200);
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    expect(quote).toMatchObject({ quoteStatus: "ACCEPTED", subtotalCents: 150000, totalCents: 150000, depositBaseCents: 120000 });
    expect(quote.lines.find((l) => l.id === lineId)).toMatchObject({ optionalAccepted: true, subscriptionId: null });
    const proof = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId: id } });
    expect(proof.optionalChoices).toEqual([
      { lineId, description: "Maintenance annuelle", amountCents: 30000, interval: "YEAR", commitmentMonths: 24, accepted: true },
    ]);
    // Rien d'activé à la signature : l'abonnement attend la livraison.
    expect(await prisma.subscription.count()).toBe(0);
    // Signature datée dans le passé : l'engagement de l'option court depuis la livraison, pas depuis la signature.
    await prisma.invoice.update({ where: { id }, data: { quoteDecidedAt: new Date("2026-01-15T10:00:00Z") } });
    const before = Date.now();
    const started = await call("POST", `/api/quotes/${id}/start-subscription`);
    expect(started.statusCode, started.body).toBe(200);
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId: quote.clientId } });
    expect(sub).toMatchObject({ amountCents: 30000, billingInterval: "YEAR", commitmentMonths: 24 });
    const expectedEnd = new Date(before);
    expectedEnd.setMonth(expectedEnd.getMonth() + 24);
    expect(Math.abs(sub.commitmentEndsAt!.getTime() - expectedEnd.getTime())).toBeLessThan(3 * 24 * 3600 * 1000);
  });

  it("option non retenue : jamais facturable ni activée", async () => {
    const { id, lineId } = await issuedQuote();
    expect((await signOffline(id, { optionalLines: [{ id: lineId, accepted: false }] })).statusCode).toBe(200);
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { lines: { where: BILLABLE_LINES_WHERE } } });
    expect(quote.totalCents).toBe(120000);
    expect(quote.lines.map((l) => l.description)).toEqual(["Création du site vitrine"]);
    expect((await prisma.invoiceLine.findUniqueOrThrow({ where: { id: lineId } })).optionalAccepted).toBe(false);
    expect((await call("POST", `/api/quotes/${id}/start-subscription`)).statusCode).toBe(409);
    expect(await prisma.subscription.count()).toBe(0);
  });
});

async function lastCode(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const rows = await prisma.emailOutbox.findMany({ orderBy: { createdAt: "desc" } });
    const code = rows.map((r) => parsePayload(outboxPayloadRaw(r)).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (code) return code;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("aucun code");
}

async function portalSession() {
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code: await lastCode() } });
  return verify.cookies.find((c) => c.name === "kz_portal")!.value;
}

const decide = (kz_portal: string, id: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: `/api/public/quotes/${id}/decision`,
    cookies: { kz_portal },
    payload: { decision: "ACCEPT", firstName: "Camille", lastName: "Cliente", signatureMode: "TYPED", paymentPlan: "TWO", ...extra },
  });

describe("signature dans /suivi : choix de l'option", () => {
  it("choix manquant ou invalide : 400 avant toute signature ; choix donné : accepté", async () => {
    const { id, lineId } = await issuedQuote();
    const kz_portal = await portalSession();
    const missing = await decide(kz_portal, id);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("optional_choice_required");
    const invalid = await decide(kz_portal, id, { optionalLines: [{ id: "autre", accepted: true }] });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("optional_choice_invalid");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).quoteStatus).toBe("SENT");
    const ok = await decide(kz_portal, id, { optionalLines: [{ id: lineId, accepted: false }] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId: id } })).optionalChoices).toEqual([
      expect.objectContaining({ lineId, accepted: false }),
    ]);
  });

  it("propositions : seule l'option de la proposition retenue est demandée, ses totaux recalculés", async () => {
    const client = await createClient({ displayName: "Atelier Camille", type: "B2B" });
    await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
    const svc = await createService({ name: "Maintenance annuelle", unitPriceCents: 30000 });
    const site3 = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    const q = (
      await call("POST", "/api/invoices", {
        clientId: client.id,
        documentType: "QUOTE",
        options: [
          { label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "TWO", lines: [site, optionLine(svc.id)] },
          {
            label: "Abonnement annuel",
            billingMode: "RECURRING",
            lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: site3.id, commitmentMonths: 36 }],
          },
        ],
      })
    ).json();
    expect((await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
    const optionA = await prisma.quoteOption.findFirstOrThrow({ where: { quoteId: q.id, position: 0 } });
    expect(optionA.totalCents).toBe(120000);
    const lineId = (await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: q.id, isOptional: true } })).id;
    // Proposition B : l'option de A n'est pas demandée, et n'est pas acceptée si elle est envoyée.
    const wrong = await signOffline(q.id, { optionId: q.options[1].id, optionalLines: [{ id: lineId, accepted: true }] });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("OPTIONAL_CHOICE_INVALID");
    const res = await signOffline(q.id, { optionId: q.options[0].id, optionalLines: [{ id: lineId, accepted: true }] });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prisma.quoteOption.findUniqueOrThrow({ where: { id: optionA.id } })).toMatchObject({ totalCents: 150000 });
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).toMatchObject({ totalCents: 150000, depositBaseCents: 120000 });
  });
});
