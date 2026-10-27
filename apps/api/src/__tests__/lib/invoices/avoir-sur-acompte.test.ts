import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CreditNoteReason, RefundMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { computeBalanceSummary, generateBalanceInvoice, generateMilestoneInvoice } from "@/lib/invoices/documentFlowService.js";
import { createCreditNote } from "@/lib/invoices/credit-note-service.js";
import { applySettledStatus } from "@/lib/invoices/balance-status.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Décision d'Alexandre du 27/10/2026 : un avoir sur un acompte corrige l'acompte seulement ; le marché reste au prix
// signé et le solde absorbe la différence (1000 € signé, acompte 300, avoir 100 : solde 800).
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-avoir-acompte@kouzia.test";
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

async function signedQuoteWithDeposit() {
  const client = await createClient({ displayName: "Client Avoir Acompte", type: "B2B" });
  const q = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 1000 }] })).json();
  expect((await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  expect((await call("POST", `/api/quotes/${q.id}/sign-offline`, { signerName: "Léa Martin" })).statusCode).toBe(200);
  await call("GET", `/api/quotes/${q.id}/market`);
  await prisma.paymentMilestone.deleteMany({ where: { quoteId: q.id } });
  await prisma.paymentMilestone.createMany({
    data: [
      { quoteId: q.id, position: 0, label: "Acompte", percentBps: 3000, amountCents: 30000, triggerText: "À la signature" },
      { quoteId: q.id, position: 1, label: "Solde", percentBps: 7000, amountCents: 70000, triggerText: "À la livraison" },
    ],
  });
  const first = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId: q.id, position: 0 } });
  const deposit = await generateMilestoneInvoice(first.id);
  expect(deposit.totalCents).toBe(30000);
  return { quoteId: q.id as string, depositId: deposit.id };
}

async function pay(invoiceId: string, amountCents: number) {
  await prisma.payment.create({ data: { invoiceId, amountCents, paidAt: new Date(), method: "BANK_TRANSFER" } });
  await prisma.$transaction((tx) => applySettledStatus(tx, invoiceId));
}

describe("avoir sur acompte : le solde absorbe la différence", () => {
  it("1000 € signé, acompte 300, avoir 100 déduit, 200 réglés : solde 800", async () => {
    const { quoteId, depositId } = await signedQuoteWithDeposit();
    await createCreditNote(depositId, { amountCents: 10000, reason: CreditNoteReason.AMOUNT_CORRECTION, refundMethod: RefundMethod.DEDUCT_FROM_BALANCE });
    await pay(depositId, 20000);

    const summary = await computeBalanceSummary(quoteId);
    expect(summary.marketTotalCents).toBe(100000);
    expect(summary.balanceDueCents).toBe(80000);

    const { invoice } = await generateBalanceInvoice(quoteId);
    expect(invoice.totalCents).toBe(80000);
  });

  it("acompte réglé puis avoir remboursé de 100 : solde 800, marché encaissé en entier", async () => {
    const { quoteId, depositId } = await signedQuoteWithDeposit();
    await pay(depositId, 30000);
    await createCreditNote(depositId, { amountCents: 10000, reason: CreditNoteReason.COMMERCIAL_GESTURE, refundMethod: RefundMethod.BANK_TRANSFER });

    const summary = await computeBalanceSummary(quoteId);
    expect(summary.balanceDueCents).toBe(80000);
    expect(summary.acomptes[0]?.amountCents).toBe(20000);
  });
});
