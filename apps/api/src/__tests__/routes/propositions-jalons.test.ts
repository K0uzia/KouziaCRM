import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 (P0) : sur un devis à 2 propositions, ouvrir la fiche (GET /market, /milestones) créait un
// échéancier d'acompte « fantôme » (offre nulle à l'émission, réglages par défaut, proposition la moins chère) ; signé
// sur la proposition abonnement, ce jalon passait « à payer » et son lien de paiement partait au client.
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-propositions-jalons@kouzia.test";
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


describe("devis à 2 propositions : aucun jalon avant le choix, aucun pour l'abonnement retenu", () => {
  it("fiche ouverte avant la signature : aucun échéancier créé", async () => {
    const q = await issuedQuote();
    expect((await call("GET", `/api/quotes/${q.id}/market`)).statusCode).toBe(200);
    await call("GET", `/api/invoices/${q.id}/milestones`);
    expect(await prisma.paymentMilestone.count({ where: { quoteId: q.id } })).toBe(0);
  });

  it("fiche ouverte puis proposition abonnement signée : aucun acompte à payer", async () => {
    const q = await issuedQuote();
    await call("GET", `/api/quotes/${q.id}/market`);
    await call("GET", `/api/invoices/${q.id}/milestones`);
    const b = q.options[1]!;
    const res = await sign(q.id, { optionId: b.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(await prisma.paymentMilestone.count({ where: { quoteId: q.id } })).toBe(0);
    await call("GET", `/api/quotes/${q.id}/market`);
    expect(await prisma.paymentMilestone.count({ where: { quoteId: q.id } })).toBe(0);
  });

  it("jalons fantômes déjà en base (créés avant le correctif) : retirés à la signature de l'abonnement", async () => {
    const q = await issuedQuote();
    await prisma.paymentMilestone.createMany({
      data: [
        { quoteId: q.id, position: 1, label: "Acompte", percentBps: 3000, amountCents: 45000, triggerText: "À la signature", status: "PENDING" },
        { quoteId: q.id, position: 2, label: "Solde", percentBps: 7000, amountCents: 105000, triggerText: "À la livraison", status: "PENDING" },
      ],
    });
    expect((await sign(q.id, { optionId: q.options[1]!.id })).statusCode).toBe(200);
    expect(await prisma.paymentMilestone.count({ where: { quoteId: q.id } })).toBe(0);
  });

  it("fiche ouverte puis proposition paiement unique signée : l'échéancier de la proposition", async () => {
    const q = await issuedQuote();
    await call("GET", `/api/quotes/${q.id}/market`);
    const a = q.options[0]!;
    expect((await sign(q.id, { optionId: a.id })).statusCode).toBe(200);
    const ms = await prisma.paymentMilestone.findMany({ where: { quoteId: q.id }, orderBy: { position: "asc" } });
    expect(ms.reduce((s, m) => s + m.amountCents, 0)).toBe(240000);
  });
});
