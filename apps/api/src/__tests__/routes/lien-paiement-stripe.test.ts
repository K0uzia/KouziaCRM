import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { PAYMENT_LINK_REFUSED } from "@/lib/invoices/payment-link.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Lien hors Stripe (27/10/2026) : refusé à l'entrée de la route, avant toute émission ou facturation (une facture émise
// est immuable : elle ne doit pas partir sans le lien demandé, ni l'e-mail avec).
const { buildApp } = await import("@/app.js");
const { issueQuote } = await import("@/lib/invoices/transitions.js");

const ADMIN = "admin-lien@kouzia.test";
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
  cookie = `${SESSION_COOKIE}=${res.cookies.find((x) => x.name === SESSION_COOKIE)?.value}`;
});

const post = (url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: { cookie }, payload: payload as object });
const REVOLUT = { mode: "manual", url: "https://checkout.revolut.com/pay/abc" };

async function draft(documentType: "QUOTE" | "INVOICE") {
  const client = await createClient();
  return prisma.invoice.create({
    data: {
      documentType,
      invoiceType: "SIMPLE",
      status: "DRAFT",
      clientId: client.id,
      subtotalCents: 100_000,
      totalCents: 100_000,
      quoteStatus: documentType === "QUOTE" ? QuoteStatus.DRAFT : null,
      lines: { create: [{ position: 0, description: "Site vitrine", quantity: 1, unitPriceCents: 100_000, lineTotalCents: 100_000 }] },
    },
  });
}

describe("lien de paiement hors Stripe refusé avant émission", () => {
  it("émission d'une facture : 400, la facture reste en brouillon sans numéro", async () => {
    const inv = await draft("INVOICE");
    const res = await post(`/api/invoices/${inv.id}/issue`, { payment: REVOLUT, email: { send: false } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: PAYMENT_LINK_REFUSED });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe("DRAFT");
    expect(after.number).toBeNull();
  });

  it("facturation d'une échéance : 400, aucune facture créée ; lien collé sur l'échéance : 400", async () => {
    const q = await draft("QUOTE");
    await issueQuote(q.id);
    await prisma.invoice.update({ where: { id: q.id }, data: { quoteStatus: QuoteStatus.ACCEPTED, quoteDecidedAt: new Date() } });
    const deposit = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId: q.id, position: 1 } });

    const billed = await post(`/api/quotes/${q.id}/milestones/${deposit.id}/invoice`, { payment: REVOLUT });
    expect(billed.statusCode).toBe(400);
    expect(billed.json()).toEqual({ error: PAYMENT_LINK_REFUSED });
    expect(await prisma.invoice.count({ where: { documentType: "INVOICE" } })).toBe(0);

    const pasted = await post(`/api/quotes/${q.id}/milestones/${deposit.id}/payment-link`, { checkoutUrl: "https://revolut.me/kouzia", sendEmail: false });
    expect(pasted.statusCode).toBe(400);
    expect(pasted.json()).toEqual({ error: PAYMENT_LINK_REFUSED });
    expect((await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: deposit.id } })).checkoutUrl).toBeNull();
  });
});
