import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Devis à 2 propositions dans /suivi (contrat P4 validé le 25/10/2026) : options[], selectedOptionId,
// totalIsCheapestOption, et signature d'une proposition (optionId).
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

const { buildApp } = await import("@/app.js");

const EMAIL = "lou-formules@exemple.fr";
const ADMIN = "admin-portail-formules@kouzia.test";
let app: FastifyInstance;
let admin: string;

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
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  admin = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});
afterEach(async () => {
  await resetDb();
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

/** Devis à 2 propositions émis pour un professionnel, et session /suivi ouverte. */
async function setup() {
  const client = await createClient({ displayName: "Atelier Lou", type: "B2B" });
  await prisma.client.update({
    where: { id: client.id },
    data: { companyName: "Atelier Lou", lastName: "Cliente", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) },
  });
  const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
  const q = (
    await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: admin },
      payload: {
        clientId: client.id,
        documentType: "QUOTE",
        options: [
          { label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "CHOICE", lines: [{ description: "Création du site vitrine", quantity: 1, unitPriceEuros: 2400 }] },
          {
            label: "Abonnement 3 ans",
            billingMode: "RECURRING",
            openingDiscount: true,
            lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc.id, commitmentMonths: 36 }],
          },
        ],
      },
    })
  ).json();
  const issued = await app.inject({ method: "POST", url: `/api/invoices/${q.id}/issue`, headers: { cookie: admin }, payload: { email: { send: false } } });
  expect(issued.statusCode, issued.body).toBe(200);
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code: await lastCode() } });
  const kz_portal = verify.cookies.find((c) => c.name === "kz_portal")!.value;
  return { quoteId: q.id as string, options: q.options as Array<{ id: string }>, kz_portal };
}

const tracked = async (kz_portal: string, quoteId: string) =>
  ((await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json().documents as Array<Record<string, unknown>>).find(
    (d) => d.id === quoteId,
  )!;
const accept = (kz_portal: string, quoteId: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: `/api/public/quotes/${quoteId}/decision`,
    cookies: { kz_portal },
    payload: { decision: "ACCEPT", firstName: "Lou", lastName: "Cliente", signatureMode: "TYPED", ...extra },
  });

type Option = Record<string, unknown> & { id: string; letter: string; label: string };

describe("devis à 2 propositions dans /suivi (P4)", () => {
  it("avant signature : options complètes, rien de facturable au niveau du devis, total marqué", async () => {
    const { quoteId, options, kz_portal } = await setup();
    const doc = await tracked(kz_portal, quoteId);
    expect(doc).toMatchObject({ billingMode: null, totalIsCheapestOption: true, selectedOptionId: null, canAcceptQuote: true });
    for (const key of ["recurring", "paymentPlanOffer", "paymentPlans", "subscriptionBilling", "subscriptionLines"]) expect(doc).not.toHaveProperty(key);
    const [a, b] = doc.options as Option[];
    expect(a).toMatchObject({ id: options[0]!.id, position: 0, letter: "A", label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "CHOICE" });
    expect((a!.paymentPlans as Array<{ plan: string }>).map((p) => p.plan)).toEqual(["TWO", "THREE"]);
    expect(b).toMatchObject({ letter: "B", label: "Abonnement 3 ans", billingMode: "RECURRING", paymentPlanOffer: "NONE" });
    expect(b!.recurring).toMatchObject({ period: "YEAR", commitmentMonths: 36, discount: { opening: true } });
    expect((b!.subscriptionLines as Array<{ label: string }>).map((l) => l.label)).toEqual(["Site tout compris"]);
  });

  it("décision : proposition obligatoire et de ce devis ; formule contrôlée sur la proposition choisie", async () => {
    const { quoteId, options, kz_portal } = await setup();
    const missing = await accept(kz_portal, quoteId);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("option_required");
    const invalid = await accept(kz_portal, quoteId, { optionId: "inconnue" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("option_invalid");
    // A propose le choix : 2 ou 3 fois obligatoire.
    expect((await accept(kz_portal, quoteId, { optionId: options[0]!.id })).statusCode).toBe(400);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } })).quoteStatus).toBe("SENT");
  });

  it("après signature de B : le devis reprend ses champs habituels, ceux de B seulement ; options gardées", async () => {
    const { quoteId, options, kz_portal } = await setup();
    const res = await accept(kz_portal, quoteId, { optionId: options[1]!.id });
    expect(res.statusCode, res.body).toBe(200);
    const doc = await tracked(kz_portal, quoteId);
    expect(doc).toMatchObject({ quoteStatus: "ACCEPTED", selectedOptionId: options[1]!.id, billingMode: "RECURRING", paymentPlanOffer: "NONE" });
    expect(doc).not.toHaveProperty("totalIsCheapestOption");
    expect((doc.subscriptionLines as Array<{ label: string }>).map((l) => l.label)).toEqual(["Site tout compris"]);
    expect((doc.options as Option[]).map((o) => o.letter)).toEqual(["A", "B"]);
    const proof = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId } });
    expect(proof).toMatchObject({ source: "PORTAL", optionId: options[1]!.id, optionLabel: "B : Abonnement 3 ans" });
  });
});
