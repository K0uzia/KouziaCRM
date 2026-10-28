import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CreditNoteReason, InvoiceType, PaymentMethod, RefundMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { computeBalanceSummary, generateMilestoneInvoice } from "@/lib/invoices/documentFlowService.js";
import { createCreditNote } from "@/lib/invoices/credit-note-service.js";
import { payPageInfo } from "@/lib/stripe/pay-page.js";
import { markMilestonePaidManually } from "@/lib/payments/milestonePaymentService.js";
import { formatEUR } from "@/lib/money.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

/**
 * Échéances d'un devis en paiement unique (régressions de l'audit du 28/10/2026) : avoir sur la 1re échéance, puis
 * facture et lien de paiement de la dernière ; libellé des acomptes ; projet supprimé et solde payé.
 */
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-echeances@kouzia.test";
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
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

async function signedOneOff(euros: number, offer: "TWO" | "THREE") {
  const client = await createClient({ displayName: "Client Échéances", type: "B2B" });
  const q = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", paymentPlanOffer: offer, lines: [{ description: "Site", quantity: 1, unitPriceEuros: euros }] })).json();
  expect((await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  expect((await call("POST", `/api/quotes/${q.id}/sign-offline`, { signerName: "Léa Martin" })).statusCode).toBe(200);
  const milestones = await prisma.paymentMilestone.findMany({ where: { quoteId: q.id }, orderBy: { position: "asc" } });
  return { quoteId: q.id as string, milestones };
}

describe("paiement unique : facture de chaque échéance", () => {
  it("libellé de la facture d'acompte en 3 fois : pourcentage à deux décimales (33,33 %)", async () => {
    const { milestones } = await signedOneOff(3000, "THREE");
    expect(milestones.map((m) => m.amountCents)).toEqual([100000, 100000, 100000]);
    // Solde attendu tant que les acomptes suivent l'échéancier : le montant prévu, pas tout le marché.
    expect((await payPageInfo("milestone", milestones[2]!.id))?.detail).toBe(`Montant à régler : ${formatEUR(100000)}`);
    const deposit = await generateMilestoneInvoice(milestones[0]!.id);
    const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: deposit.id } });
    expect(line.description).toMatch(/^Acompte de 33,33 % sur devis/);
  });

  it("avoir qui annule la 1re échéance : la dernière devient la facture de SOLDE du marché, pas un acompte du jalon", async () => {
    const { quoteId, milestones } = await signedOneOff(1000, "TWO");
    expect(milestones.map((m) => [m.label, m.amountCents])).toEqual([["1re échéance", 50000], ["2e échéance", 50000]]);
    const first = await generateMilestoneInvoice(milestones[0]!.id);
    // Acompte annulé en entier par un avoir (client qui préfère tout régler à la livraison).
    await createCreditNote(first.id, { amountCents: 50000, reason: CreditNoteReason.AMOUNT_CORRECTION, refundMethod: RefundMethod.DEDUCT_FROM_BALANCE });
    expect((await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: milestones[0]!.id } })).status).toBe("CANCELLED");
    const summary = await computeBalanceSummary(quoteId);
    expect(summary.balanceDueCents).toBe(100000);
    // Lien de paiement de la dernière échéance avant sa facture : le solde réel, pas le montant du jalon.
    const info = await payPageInfo("milestone", milestones[1]!.id);
    expect(info?.detail).toBe(`Montant à régler : ${formatEUR(100000)}`);
    const last = await generateMilestoneInvoice(milestones[1]!.id);
    expect({ type: last.invoiceType, total: last.totalCents }).toEqual({ type: InvoiceType.SOLDE, total: 100000 });
    expect((await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: milestones[1]!.id } })).amountCents).toBe(100000);
  });

  it("solde payé : un projet supprimé n'est pas recréé ; un acompte payé démarre le projet", async () => {
    const { quoteId, milestones } = await signedOneOff(1000, "TWO");
    const first = await generateMilestoneInvoice(milestones[0]!.id);
    await markMilestonePaidManually({ milestoneId: milestones[0]!.id, method: PaymentMethod.BANK_TRANSFER, notifyClient: false });
    expect(await prisma.clientProject.count({ where: { quoteId } })).toBe(1);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("PAID");
    await prisma.clientProject.deleteMany({ where: { quoteId } });
    await generateMilestoneInvoice(milestones[1]!.id);
    await markMilestonePaidManually({ milestoneId: milestones[1]!.id, method: PaymentMethod.BANK_TRANSFER, notifyClient: false });
    expect(await prisma.clientProject.count({ where: { quoteId } })).toBe(0);
  });
});
