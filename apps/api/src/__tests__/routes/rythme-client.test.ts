import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { invalidateCompanySettingsCache, getCompanySettings } from "@/lib/company.js";
import { subscriptionMethodTypes } from "@/lib/stripe/payment-methods.js";
import { pdfText } from "../helpers/pdf-text.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Rythme de paiement au choix du client (décisions d'Alexandre du 28/10/2026) : Alexandre coche les rythmes proposés,
// le devis porte le prix annuel, le client choisit à la signature ; activation au rythme et au montant retenus.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

const { buildApp } = await import("@/app.js");
const { acceptQuoteFromThread } = await import("@/lib/invoices/transitions.js");

const EMAIL = "rythme@exemple.fr";
const ADMIN = "admin-rythme@kouzia.test";
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
  // Production : 1 mois offert sur l'annuel, carte jusqu'à 300 €, prélèvement SEPA actif.
  await prisma.companySettings.updateMany({ data: { annualFreeMonths: 1, publicTrackingShowAmounts: true, paymentSepaEnabled: true, paymentCardEnabled: true, paymentCardMaxCents: 30000 } });
  invalidateCompanySettingsCache();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

const annualLine = (serviceId: string, extra: Record<string, unknown> = {}) => ({
  description: "Site tout compris",
  quantity: 1,
  unitPriceEuros: 1500,
  isSubscription: true,
  billingInterval: "YEAR",
  billingDay: 1,
  serviceId,
  commitmentMonths: 12,
  ...extra,
});

async function clientWithEmail() {
  const client = await createClient({ displayName: "Atelier Rythme", type: "B2B" });
  await prisma.client.update({
    where: { id: client.id },
    data: { companyName: "Atelier Rythme", lastName: "Client", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) },
  });
  return client;
}

async function issuedQuote(body: Record<string, unknown> = {}, lineExtra: Record<string, unknown> = {}) {
  const client = await clientWithEmail();
  const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
  const res = await call("POST", "/api/invoices", {
    clientId: client.id,
    documentType: "QUOTE",
    billingMode: "RECURRING",
    offeredIntervals: ["YEAR", "QUARTER", "MONTH"],
    lines: [annualLine(svc.id, lineExtra)],
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  const issued = await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } });
  expect(issued.statusCode, issued.body).toBe(200);
  return { id, clientId: client.id };
}

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
    payload: { decision: "ACCEPT", firstName: "Camille", lastName: "Client", signatureMode: "TYPED", ...extra },
  });

const trackingDoc = async (kz_portal: string, id: string) =>
  (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json().documents.find((d: { id: string }) => d.id === id);

describe("éditeur : rythmes proposés", () => {
  it("enregistrés sur le devis récurrent ; un seul rythme : null, comme avant", async () => {
    const client = await clientWithEmail();
    const svc = await createService({ name: "Site tout compris" });
    const many = await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "RECURRING", offeredIntervals: ["MONTH", "YEAR"], lines: [annualLine(svc.id)] });
    expect(many.statusCode, many.body).toBe(201);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: many.json().id } })).offeredIntervals).toBe("YEAR,MONTH");
    const one = await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "RECURRING", offeredIntervals: ["YEAR"], lines: [annualLine(svc.id)] });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: one.json().id } })).offeredIntervals).toBeNull();
    // Brouillon modifié : les rythmes suivent, un seul les retire.
    const patched = await call("PUT", `/api/invoices/${one.json().id}`, { offeredIntervals: ["YEAR", "QUARTER"] });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: one.json().id } })).offeredIntervals).toBe("YEAR,QUARTER");
  });

  it("refusés hors récurrent, sur des lignes qui ne portent pas le prix annuel, et avec une remise en montant par échéance", async () => {
    const client = await clientWithEmail();
    const svc = await createService({ name: "Site tout compris" });
    const base = { clientId: client.id, documentType: "QUOTE", offeredIntervals: ["YEAR", "MONTH"] };
    const monthly = await call("POST", "/api/invoices", { ...base, billingMode: "RECURRING", lines: [annualLine(svc.id, { billingInterval: "MONTH", unitPriceEuros: 136.36 })] });
    expect(monthly.statusCode).toBe(400);
    expect(monthly.json().error).toMatch(/prix annuel/);
    const oneOff = await call("POST", "/api/invoices", { ...base, billingMode: "ONE_OFF", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 900 }] });
    expect(oneOff.statusCode).toBe(400);
    expect(oneOff.json().error).toMatch(/récurrent/);
    const fixed = await call("POST", "/api/invoices", { ...base, billingMode: "RECURRING", lines: [annualLine(svc.id)], recurringDiscount: { kind: "FIXED", euros: 10, months: 12 } });
    expect(fixed.statusCode).toBe(400);
    expect(fixed.json().error).toMatch(/un seul rythme/);
    // Durée de remise : multiple de la période la plus longue proposée (trimestre et mois : 3).
    const quarter = await call("POST", "/api/invoices", { ...base, offeredIntervals: ["QUARTER", "MONTH"], billingMode: "RECURRING", lines: [annualLine(svc.id)], recurringDiscount: { kind: "PERCENT", percent: 10, months: 6 } });
    expect(quarter.statusCode, quarter.body).toBe(201);
  });
});

describe("/suivi : rythmes proposés avant la signature", () => {
  it("un rang par rythme : prix par échéance et total sur l'engagement (1 mois offert)", async () => {
    const { id } = await issuedQuote();
    const kz_portal = await portalSession();
    const doc = await trackingDoc(kz_portal, id);
    expect(doc.recurring).toMatchObject({ period: "YEAR", amountCents: 150000, commitmentMonths: 12, intervalChoiceRequired: true });
    expect(doc.recurring.intervalChoices).toEqual([
      { interval: "YEAR", periods: 1, amountCents: 150000, totalCommitmentCents: 150000 },
      { interval: "QUARTER", periods: 4, amountCents: 40909, totalCommitmentCents: 163636 },
      { interval: "MONTH", periods: 12, amountCents: 13636, totalCommitmentCents: 163632 },
    ]);
    // Mois offerts figés à l'émission : un changement de réglage ne change pas le devis émis.
    await prisma.companySettings.updateMany({ data: { annualFreeMonths: 2 } });
    invalidateCompanySettingsCache();
    expect((await trackingDoc(kz_portal, id)).recurring.intervalChoices[2].amountCents).toBe(13636);
  });

  it("remise d'ouverture : recomptée au rythme (30 % sur 12 mois, engagement de 36 mois)", async () => {
    const { id } = await issuedQuote({ openingDiscount: true }, { commitmentMonths: 36 });
    const kz_portal = await portalSession();
    const rows = (await trackingDoc(kz_portal, id)).recurring.intervalChoices;
    expect(rows[0]).toMatchObject({ interval: "YEAR", periods: 3, totalCommitmentCents: 150000 * 3 - 45000, discount: { periods: 1, discountedAmountCents: 105000 } });
    expect(rows[2]).toMatchObject({ interval: "MONTH", periods: 36, totalCommitmentCents: 13636 * 36 - 4091 * 12, discount: { periods: 12, discountedAmountCents: 9545 } });
  });
});

describe("signature : rythme obligatoire, refusé s'il n'est pas proposé", () => {
  it("/suivi : manquant ou étranger, 400 avant le code (code toujours valable) ; mensuel retenu, devis et abonnement au rythme", async () => {
    const { id, clientId } = await issuedQuote({ offeredIntervals: ["YEAR", "MONTH"] });
    const kz_portal = await portalSession();
    await prisma.emailOutbox.deleteMany();
    await app.inject({ method: "POST", url: `/api/public/quotes/${id}/sign-code`, cookies: { kz_portal } });
    const code = await lastCode();
    const missing = await decide(kz_portal, id, { code });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("interval_choice_required");
    const invalid = await decide(kz_portal, id, { code, billingInterval: "QUARTER" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("interval_choice_invalid");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).quoteStatus).toBe("SENT");
    const ok = await decide(kz_portal, id, { code, billingInterval: "MONTH" });
    expect(ok.statusCode, ok.body).toBe(200);

    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { lines: true } });
    expect(quote).toMatchObject({ quoteStatus: "ACCEPTED", offeredIntervals: null, subtotalCents: 13636, totalCents: 13636 });
    expect(quote.lines[0]).toMatchObject({ billingInterval: null, unitPriceCents: 13636, lineTotalCents: 13636 });
    const proof = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId: id } });
    expect(proof).toMatchObject({ billingInterval: "MONTH", billingPeriodCents: 13636, authMethod: "SIGN_CODE" });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId } });
    expect(sub).toMatchObject({ amountCents: 13636, billingInterval: "MONTH", commitmentMonths: 12 });

    // Après la signature : plus de choix, le rythme retenu seulement.
    const doc = await trackingDoc(kz_portal, id);
    expect(doc.recurring).toMatchObject({ period: "MONTH", amountCents: 13636, periods: 12, totalCommitmentCents: 163632 });
    expect(doc.recurring).not.toHaveProperty("intervalChoices");
  });

  it("annuel au-delà du plafond carte : prélèvement SEPA proposé, abonnement annuel au prix du devis", async () => {
    const { id, clientId } = await issuedQuote();
    const kz_portal = await portalSession();
    expect((await decide(kz_portal, id, { billingInterval: "YEAR" })).statusCode).toBe(200);
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId } });
    expect(sub).toMatchObject({ amountCents: 150000, billingInterval: "YEAR" });
    expect(subscriptionMethodTypes(sub.amountCents, await getCompanySettings())).toEqual(["sepa_debit"]);
  });

  it("hors ligne et messagerie : rythme exigé aussi ; trimestriel retenu avec la remise d'ouverture", async () => {
    const { id, clientId } = await issuedQuote({ openingDiscount: true }, { commitmentMonths: 36 });
    // Fenêtres de signature : montant d'une échéance par rythme, lu sur la fiche du devis.
    expect((await call("GET", `/api/invoices/${id}`)).json().intervalChoices).toEqual([
      { interval: "YEAR", amountCents: 150000 },
      { interval: "QUARTER", amountCents: 40909 },
      { interval: "MONTH", amountCents: 13636 },
    ]);
    const missing = await call("POST", `/api/quotes/${id}/sign-offline`, { signerName: "Camille Client" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("INTERVAL_CHOICE_REQUIRED");
    const thread = await prisma.emailThread.create({ data: { subject: "Devis", participants: "[]", lastMessageAt: new Date(), clientId } });
    const fromThread = await call("POST", `/api/quotes/${id}/accept-from-thread`, { threadId: thread.id, signerName: "Camille Client" });
    expect(fromThread.statusCode).toBe(400);
    expect(fromThread.json().code).toBe("INTERVAL_CHOICE_REQUIRED");
    await expect(acceptQuoteFromThread(id, { threadId: thread.id, signerName: "Camille Client", actor: {}, billingInterval: "WEEK" })).rejects.toMatchObject({ code: "INTERVAL_CHOICE_INVALID" });

    const ok = await call("POST", `/api/quotes/${id}/sign-offline`, { signerName: "Camille Client", billingInterval: "QUARTER" });
    expect(ok.statusCode, ok.body).toBe(200);
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId } });
    // 30 % sur les 12 premiers mois, soit 4 trimestres remisés.
    expect(sub).toMatchObject({ amountCents: 40909, billingInterval: "QUARTER", commitmentMonths: 36, discountKind: "PERCENT", discountValue: 3000, discountPeriods: 4 });
    expect((await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId: id } })).billingInterval).toBe("QUARTER");
  });

  it("un seul rythme : aucun choix demandé, un rythme envoyé doit être celui du devis", async () => {
    const { id } = await issuedQuote({ offeredIntervals: null }, { billingInterval: "MONTH", unitPriceEuros: 136.36 });
    const kz_portal = await portalSession();
    expect((await trackingDoc(kz_portal, id)).recurring).not.toHaveProperty("intervalChoices");
    const wrong = await decide(kz_portal, id, { billingInterval: "YEAR" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().code).toBe("interval_choice_invalid");
    expect((await decide(kz_portal, id)).statusCode).toBe(200);
    expect((await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId: id } })).billingInterval).toBeNull();
  });
});

describe("PDF : tableau des rythmes avant la signature, rythme retenu après", () => {
  it("non signé : rythme au choix ; signé : plus de tableau, l'abonnement au rythme retenu", async () => {
    const { id } = await issuedQuote();
    const before = pdfText((await call("GET", `/api/invoices/${id}/pdf`)).rawPayload);
    expect(before).toContain("Rythme de paiement au choix");
    expect(before).toContain("409,09");
    expect(before).toMatch(/1.636,32/);
    expect(before).toContain("au rythme choisi");
    expect((await call("POST", `/api/quotes/${id}/sign-offline`, { signerName: "Camille Client", billingInterval: "MONTH" })).statusCode).toBe(200);
    const after = pdfText((await call("GET", `/api/invoices/${id}/pdf`)).rawPayload);
    expect(after).not.toContain("Rythme de paiement au choix");
    expect(after).toContain("136,36");
  });
});

describe("propositions : rythme au choix dans une proposition", () => {
  it("proposition récurrente à rythmes : rythme exigé à la signature de cette proposition", async () => {
    const client = await clientWithEmail();
    const svc = await createService({ name: "Site tout compris" });
    const res = await call("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      options: [
        { label: "Site seul", billingMode: "ONE_OFF", paymentPlanOffer: "TWO", lines: [{ description: "Création du site", quantity: 1, unitPriceEuros: 1200 }] },
        { label: "Abonnement", billingMode: "RECURRING", offeredIntervals: ["YEAR", "MONTH"], lines: [annualLine(svc.id)] },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    expect((await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } })).statusCode).toBe(200);
    const optionB = await prisma.quoteOption.findFirstOrThrow({ where: { quoteId: id, position: 1 } });
    expect(optionB.offeredIntervals).toBe("YEAR,MONTH");
    const kz_portal = await portalSession();
    const doc = await trackingDoc(kz_portal, id);
    expect(doc.options[1].recurring.intervalChoices.map((r: { interval: string }) => r.interval)).toEqual(["YEAR", "MONTH"]);
    const missing = await decide(kz_portal, id, { optionId: optionB.id });
    expect(missing.json().code).toBe("interval_choice_required");
    expect((await decide(kz_portal, id, { optionId: optionB.id, billingInterval: "MONTH" })).statusCode).toBe(200);
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(quote).toMatchObject({ selectedOptionId: optionB.id, offeredIntervals: null, totalCents: 13636 });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId: client.id } });
    expect(sub).toMatchObject({ amountCents: 13636, billingInterval: "MONTH" });
  });
});
