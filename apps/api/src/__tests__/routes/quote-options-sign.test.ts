import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Devis à 2 propositions (P3, 25/10/2026) : signature d'une proposition, preuve, et seules ses lignes facturées.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-propositions-signature@kouzia.test";
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

async function issuedQuote() {
  const client = await createClient({ displayName: "Client Signature Formules" });
  const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
  const q = (
    await call("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      options: [
        { label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "TWO", lines: [{ description: "Création du site vitrine", quantity: 1, unitPriceEuros: 2400 }] },
        {
          label: "Abonnement 3 ans",
          billingMode: "RECURRING",
          lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc.id, commitmentMonths: 36 }],
        },
      ],
    })
  ).json();
  const issued = await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } });
  expect(issued.statusCode, issued.body).toBe(200);
  return q as { id: string; options: Array<{ id: string; label: string; totalCents: number }> };
}

const sign = (id: string, extra: Record<string, unknown> = {}) => call("POST", `/api/quotes/${id}/sign-offline`, { signerName: "Léa Martin", ...extra });

describe("signature d'un devis à 2 propositions (P3)", () => {
  it("proposition obligatoire et du même devis", async () => {
    const q = await issuedQuote();
    const other = await issuedQuote();
    const missing = await sign(q.id);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("OPTION_REQUIRED");
    const foreign = await sign(q.id, { optionId: other.options[0]!.id });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().code).toBe("OPTION_INVALID");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).quoteStatus).toBe("SENT");
  });

  it("proposition A (paiement unique) : recopiée sur le devis, preuve, échéancier ; ni abonnement ni ligne de B facturée", async () => {
    const q = await issuedQuote();
    const [a] = q.options;
    const res = await sign(q.id, { optionId: a!.id });
    expect(res.statusCode, res.body).toBe(200);
    const signed = await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } });
    expect(signed).toMatchObject({ quoteStatus: "ACCEPTED", selectedOptionId: a!.id, billingMode: "ONE_OFF", paymentPlanOffer: "TWO", paymentPlan: "TWO", totalCents: 240000, depositBaseCents: 240000 });
    const proof = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId: q.id } });
    expect(proof).toMatchObject({ optionId: a!.id, optionLabel: "A : Paiement unique", optionTotalCents: 240000 });
    expect(await prisma.paymentMilestone.count({ where: { quoteId: q.id } })).toBe(2);
    expect(await prisma.subscription.count({ where: { clientId: signed.clientId } })).toBe(0);

    // Facture depuis le devis : seulement la ligne de la proposition retenue.
    const invoice = await call("POST", `/api/invoices/${q.id}/convert`);
    expect(invoice.statusCode, invoice.body).toBe(201);
    expect(invoice.json().lines.map((l: { description: string }) => l.description)).toEqual(["Création du site vitrine"]);
  });

  it("proposition B (abonnement) : un seul abonnement, créé depuis la ligne de B ; aucun échéancier", async () => {
    const q = await issuedQuote();
    const [, b] = q.options;
    const res = await sign(q.id, { optionId: b!.id });
    expect(res.statusCode, res.body).toBe(200);
    const signed = await prisma.invoice.findUniqueOrThrow({ where: { id: q.id }, include: { lines: true } });
    expect(signed).toMatchObject({ selectedOptionId: b!.id, billingMode: "RECURRING", paymentPlanOffer: "NONE" });
    const subs = await prisma.subscription.findMany({ where: { clientId: signed.clientId } });
    expect(subs).toHaveLength(1);
    const linked = signed.lines.filter((l) => l.subscriptionId);
    expect(linked.map((l) => l.optionId)).toEqual([b!.id]);
    expect(await prisma.paymentMilestone.count({ where: { quoteId: q.id } })).toBe(0);
  });

  it("devis simple : optionId refusé", async () => {
    const client = await createClient({ displayName: "Client Simple" });
    const q = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", lines: [{ description: "Audit", quantity: 1, unitPriceEuros: 600 }] })).json();
    await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } });
    const res = await sign(q.id, { optionId: "inexistant" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("OPTION_INVALID");
  });
});
