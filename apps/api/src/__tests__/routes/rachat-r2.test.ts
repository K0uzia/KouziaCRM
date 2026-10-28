import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const alertAdmin = vi.fn(async () => undefined);
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));
const stripeAction = vi.fn(async () => undefined);
vi.mock("@/lib/stripe/subscription-control.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/subscription-control.js")>()),
  applyStripeSubscriptionAction: stripeAction,
}));

const { buildApp } = await import("@/app.js");
const { applyPaidBuyouts, createBuyoutQuote, currentPeriodEndOf, closeBoughtOutSubscriptions, finishBuyoutSignature } = await import("@/lib/subscriptions/buyout.js");
const { issueQuote, acceptQuoteByClient, convertQuoteToInvoice } = await import("@/lib/invoices/transitions.js");
const { generateDueSubscriptionInvoices } = await import("@/lib/subscriptions/subscription-service.js");
const { generateMilestoneInvoice, generateBalanceInvoice } = await import("@/lib/invoices/documentFlowService.js");
const { loadDocumentForPdf, pdfDataOfLoaded } = await import("@/lib/pdf/document-pdf.js");

const ADMIN = "admin-rachat2@kouzia.test";
let app: FastifyInstance;
let cookie = "";
let clientId = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await ensureDefaultLegalClauses();
  alertAdmin.mockClear();
  stripeAction.mockReset();
  stripeAction.mockResolvedValue(undefined);
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
  ({ id: clientId } = await createClient({ displayName: "Client du rachat" }));
});

const call = (method: "GET" | "PUT", url: string, payload?: unknown) => app.inject({ method, url, headers: { cookie }, payload: payload as never });

/** Abonnement annuel engagé 36 mois, prochaine échéance dans environ 6 mois, et son devis de rachat émis. */
async function issuedBuyoutQuote(extra: { stripeSubscriptionId?: string; endDate?: Date } = {}) {
  const offer = await prisma.service.create({ data: { name: "Vitrine", unitPriceCents: 36_000, isSubscription: true, billingInterval: "YEAR" } });
  const buyout = await prisma.service.create({ data: { name: "Rachat du site Vitrine", unitPriceCents: 75_000 } });
  await prisma.service.update({ where: { id: offer.id }, data: { buyoutServiceId: buyout.id } });
  const next = new Date();
  next.setMonth(next.getMonth() + 6, 1);
  next.setHours(0, 0, 0, 0);
  const sub = await prisma.subscription.create({
    data: {
      clientId,
      serviceId: offer.id,
      label: "Vitrine : annuel",
      amountCents: 36_000,
      billingDay: 1,
      billingInterval: "YEAR",
      startDate: new Date(next.getFullYear() - 1, next.getMonth(), 1),
      nextInvoiceAt: next,
      commitmentMonths: 36,
      commitmentEndsAt: new Date(next.getFullYear() + 2, next.getMonth(), 1),
      ...(extra.stripeSubscriptionId ? { stripeSubscriptionId: extra.stripeSubscriptionId, collectionMethod: "STRIPE", stripeLivemode: false } : {}),
      ...(extra.endDate ? { endDate: extra.endDate } : {}),
    },
  });
  const { id } = await createBuyoutQuote(sub.id);
  await issueQuote(id);
  return { sub, quoteId: id, periodEnd: currentPeriodEndOf(sub) };
}

/** Règle le prix du rachat (facture de l'échéancier, sinon facture issue de la conversion) puis applique le rachat payé. */
async function payBuyout(quoteId: string) {
  let inv = await prisma.invoice.findFirst({ where: { sourceQuoteId: quoteId, documentType: "INVOICE" } });
  if (!inv) {
    const milestone = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId } });
    await generateMilestoneInvoice(milestone.id).catch(() => generateBalanceInvoice(quoteId));
    inv = await prisma.invoice.findFirstOrThrow({ where: { sourceQuoteId: quoteId, documentType: "INVOICE" } });
  }
  await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: inv.totalCents, paidAt: new Date(), method: "BANK_TRANSFER" } });
  await prisma.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });
  return applyPaidBuyouts();
}

describe("rachat R2 : la signature ne coupe rien, le paiement du rachat met fin à l'abonnement (décision du 28/10/2026)", () => {
  it("payé : fin au dernier instant de la période en cours, jamais de nouvelle échéance, clôturé ensuite par le worker", async () => {
    const { sub, quoteId, periodEnd } = await issuedBuyoutQuote();
    await acceptQuoteByClient(quoteId, "Lou Martin", { source: "ADMIN" });
    // Signé, pas encore payé : l'abonnement continue.
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).endDate).toBeNull();
    expect(await applyPaidBuyouts()).toBe(0);
    expect(await payBuyout(quoteId)).toBe(1);
    expect(await applyPaidBuyouts()).toBe(0);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.endDate?.getTime()).toBe(periodEnd.getTime() - 1);
    expect(after.status).toBe("ACTIVE");

    // À la date de la prochaine échéance : aucune facture d'abonnement.
    expect(await generateDueSubscriptionInvoices(new Date(periodEnd.getTime() + 60_000))).toBe(0);
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id } })).toBe(0);

    expect(await closeBoughtOutSubscriptions(new Date(periodEnd.getTime() - 60_000))).toBe(0);
    expect(await closeBoughtOutSubscriptions(periodEnd)).toBe(1);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("ENDED");

    // Fiche : rachat signé, plus de proposition.
    const state = (await call("GET", `/api/subscriptions/${sub.id}`)).json().buyout;
    expect(state).toMatchObject({ signed: true, canPropose: false });
    expect(state).toMatchObject({ blockedReason: "Rachat signé.", remaining: null });
    expect(new Date(state.endsAt).getTime()).toBe(periodEnd.getTime() - 1);
  });

  it("une fin déjà plus proche (résiliation programmée) est gardée", async () => {
    const soon = new Date(Date.now() + 30 * 86_400_000);
    const { sub, quoteId } = await issuedBuyoutQuote({ endDate: soon });
    await acceptQuoteByClient(quoteId, "Lou Martin", { source: "ADMIN" });
    await payBuyout(quoteId);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).endDate?.getTime()).toBe(soon.getTime());
  });

  it("facture du rachat liée à l'abonnement, par l'échéancier comme par la conversion", async () => {
    const first = await issuedBuyoutQuote();
    await acceptQuoteByClient(first.quoteId, "Lou Martin", { source: "ADMIN" });
    const milestone = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId: first.quoteId } });
    const invoice = await generateMilestoneInvoice(milestone.id).catch(() => generateBalanceInvoice(first.quoteId));
    const generated = await prisma.invoice.findFirstOrThrow({ where: { sourceQuoteId: first.quoteId, documentType: "INVOICE" } });
    expect(invoice).toBeTruthy();
    expect(generated.buysOutSubscriptionId).toBe(first.sub.id);

    // Conversion (signé hors ligne, puis facture totale) : même lien ; fin posée au paiement de la facture, une fois.
    const second = await issuedBuyoutQuote();
    await acceptQuoteByClient(second.quoteId, "Lou Martin", { source: "ADMIN" });
    const converted = await convertQuoteToInvoice(second.quoteId);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: converted.id } })).buysOutSubscriptionId).toBe(second.sub.id);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: second.sub.id } })).endDate).toBeNull();
    await payBuyout(second.quoteId);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: second.sub.id } })).endDate?.getTime()).toBe(second.periodEnd.getTime() - 1);
  });

  it("prélèvement Stripe : fin programmée à la fin de sa période au paiement du rachat ; un refus de Stripe alerte", async () => {
    const ok = await issuedBuyoutQuote({ stripeSubscriptionId: "sub_rachat_ok" });
    await acceptQuoteByClient(ok.quoteId, "Lou Martin", { source: "ADMIN" });
    expect(stripeAction).not.toHaveBeenCalledWith("sub_rachat_ok", "endAtPeriodEnd", false);
    await payBuyout(ok.quoteId);
    expect(stripeAction).toHaveBeenCalledWith("sub_rachat_ok", "endAtPeriodEnd", false);
    expect(alertAdmin).not.toHaveBeenCalled();

    stripeAction.mockRejectedValueOnce(new Error("Stripe indisponible"));
    await finishBuyoutSignature({ subscriptionId: ok.sub.id, endDate: new Date(), stripe: { id: "sub_rachat_ko", livemode: false } });
    expect(alertAdmin).toHaveBeenCalledTimes(1);
    expect(String((alertAdmin.mock.calls[0] as unknown[])[1])).toContain("Stripe indisponible");
  });

  it("devis ordinaire signé : aucun abonnement touché", async () => {
    const { sub } = await issuedBuyoutQuote();
    const plain = await prisma.invoice.create({
      data: { documentType: "QUOTE", quoteStatus: "DRAFT", clientId, paymentPlanOffer: "ONE", billingMode: "ONE_OFF", subtotalCents: 10_000, totalCents: 10_000, lines: { create: [{ position: 1, description: "Logo", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 }] } },
    });
    await issueQuote(plain.id);
    await acceptQuoteByClient(plain.id, "Lou Martin", { source: "ADMIN" });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).endDate).toBeNull();
  });
});

describe("rachat R2 : transfert du site", () => {
  it("noté après la signature seulement ; date choisie, retirée par null", async () => {
    const { sub, quoteId } = await issuedBuyoutQuote();
    const early = await call("PUT", `/api/subscriptions/${sub.id}/transfer`, { transferredAt: "2026-10-24" });
    expect(early.statusCode).toBe(409);
    await acceptQuoteByClient(quoteId, "Lou Martin", { source: "ADMIN" });
    expect((await call("PUT", `/api/subscriptions/${sub.id}/transfer`, { transferredAt: "pas une date" })).statusCode).toBe(400);
    const set = await call("PUT", `/api/subscriptions/${sub.id}/transfer`, { transferredAt: "2026-10-24" });
    expect(set.statusCode, set.body).toBe(200);
    expect(new Date(set.json().transferredAt).getDate()).toBe(24);
    expect((await call("GET", `/api/subscriptions/${sub.id}`)).json().buyout.transferredAt).not.toBeNull();
    expect((await call("PUT", `/api/subscriptions/${sub.id}/transfer`, { transferredAt: null })).json().transferredAt).toBeNull();
    expect((await call("PUT", "/api/subscriptions/inconnu/transfer", { transferredAt: null })).statusCode).toBe(404);
  });
});

describe("rachat R2 : clause de cession (brouillon)", () => {
  it("créée inactive, sans texte juridique ; activée, imprimée sur le devis de rachat seulement", async () => {
    const clause = await prisma.legalClause.findFirstOrThrow({ where: { kind: "BUYOUT_TRANSFER" } });
    expect(clause).toMatchObject({ active: false, required: false, title: "Cession du site (rachat)" });
    expect(clause.body).toMatch(/^\[À RÉDIGER PAR ALEXANDRE/);

    await prisma.legalClause.update({ where: { id: clause.id }, data: { active: true } });
    const { quoteId } = await issuedBuyoutQuote();
    const plain = await prisma.invoice.create({
      data: { documentType: "QUOTE", quoteStatus: "DRAFT", clientId, subtotalCents: 10_000, totalCents: 10_000, lines: { create: [{ position: 1, description: "Logo", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 }] } },
    });
    await issueQuote(plain.id);
    const titles = async (id: string) => ((await pdfDataOfLoaded((await loadDocumentForPdf(id))!)).invoice.legalClauses ?? []).map((c) => c.title);
    expect(await titles(quoteId)).toContain("Cession du site (rachat)");
    expect(await titles(plain.id)).not.toContain("Cession du site (rachat)");
  });
});
