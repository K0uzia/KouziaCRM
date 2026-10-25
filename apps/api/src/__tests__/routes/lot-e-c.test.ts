import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, MilestoneStatus, PaymentMethod, QuoteStatus, SubscriptionCollectionMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Lot E-c (audit du 25/10/2026) : décalage d'avenant au marqueur, rattachement d'un paiement sans facture, annulation
// d'une fin programmée, déblocage d'un prélèvement en cours.
const { stripeAction } = vi.hoisted(() => ({ stripeAction: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock("@/lib/stripe/subscription-control.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/subscription-control.js")>()),
  applyStripeSubscriptionAction: stripeAction,
}));
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: async () => false,
}));

const { buildApp } = await import("@/app.js");
const { activateSubscriptionsFromDocument } = await import("@/lib/subscriptions/activate-from-document.js");
const { convertQuoteToInvoice } = await import("@/lib/invoices/transitions.js");

const ADMIN = "admin-lot-e-c@kouzia.test";
const DAY = 86_400_000;
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  stripeAction.mockClear();
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

const call = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function subscription(extra: Record<string, unknown> = {}) {
  const client = await createClient();
  const service = await createService({ name: "Maintenance", isSubscription: true });
  return prisma.subscription.create({
    data: { clientId: client.id, serviceId: service.id, label: "Maintenance", amountCents: 3_000, billingDay: 1, billingInterval: "MONTH", startDate: new Date(Date.now() - 60 * DAY), nextInvoiceAt: new Date(Date.now() + 20 * DAY), ...extra },
  });
}

let seq = 0;
/** Devis d'avenant mixte signé : une ligne ponctuelle et la ligne d'abonnement révisée. */
async function revisionQuote(subId: string, clientId: string, serviceId: string, line: Record<string, unknown> = {}) {
  seq += 1;
  return prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.ACCEPTED, quoteDecidedAt: new Date(),
      number: `D-2026-08${String(seq).padStart(2, "0")}`, clientId, subtotalCents: 13_500, totalCents: 13_500, issueDate: new Date(),
      lines: {
        create: [
          { position: 1, description: "Refonte", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 },
          { position: 2, description: "Maintenance révisée", quantity: 1, unitPriceCents: 3_500, lineTotalCents: 3_500, isSubscription: true, billingInterval: "MONTH", billingDay: 1, serviceId, revisesSubscriptionId: subId, ...line },
        ],
      },
    },
  });
}

describe("avenant : décalage de l'échéance au marqueur", () => {
  it("signé avec le nouveau code : rien à la signature, une période à la conversion, une seule fois", async () => {
    const sub = await subscription();
    const quote = await revisionQuote(sub.id, sub.clientId, sub.serviceId);
    await prisma.$transaction((tx) => activateSubscriptionsFromDocument(quote.id, tx));
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).nextInvoiceAt.getTime()).toBe(sub.nextInvoiceAt.getTime());
    expect((await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: quote.id, position: 2 } })).revisionShiftDeferred).toBe(true);

    await convertQuoteToInvoice(quote.id);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextInvoiceAt.getMonth()).toBe((sub.nextInvoiceAt.getMonth() + 1) % 12);
    // Marqueur consommé : le décalage ne peut plus se refaire.
    expect((await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: quote.id, position: 2 } })).revisionShiftDeferred).toBe(false);
  });

  it("signé avant le déploiement (déjà décalé à la signature par l'ancien code, sans marqueur) : pas de second décalage à la conversion", async () => {
    const sub = await subscription();
    const quote = await revisionQuote(sub.id, sub.clientId, sub.serviceId);
    // Ancien code : à la signature d'un devis mixte (ni abonnement seul ni départ différé), hors Stripe, l'échéance avançait.
    await prisma.$transaction((tx) => activateSubscriptionsFromDocument(quote.id, tx, { periodBilledNow: true }));
    const signedBefore = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(signedBefore.nextInvoiceAt.getMonth()).toBe((sub.nextInvoiceAt.getMonth() + 1) % 12);
    expect((await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: quote.id, position: 2 } })).revisionShiftDeferred).toBe(false);

    await convertQuoteToInvoice(quote.id);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).nextInvoiceAt.getTime()).toBe(signedBefore.nextInvoiceAt.getTime());
  });

  it("abonnement prélevé par Stripe : ni marqueur ni décalage (Stripe suit son calendrier)", async () => {
    const sub = await subscription({ collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_avenant" });
    const quote = await revisionQuote(sub.id, sub.clientId, sub.serviceId);
    await prisma.$transaction((tx) => activateSubscriptionsFromDocument(quote.id, tx));
    expect((await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: quote.id, position: 2 } })).revisionShiftDeferred).toBe(false);
    await convertQuoteToInvoice(quote.id);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).nextInvoiceAt.getTime()).toBe(sub.nextInvoiceAt.getTime());
  });
});

describe("paiement reçu sans facture", () => {
  async function issuedInvoice(totalCents: number) {
    const client = await createClient({ displayName: "Client du rattachement" });
    seq += 1;
    return prisma.invoice.create({
      data: { documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: `F-2026-08${String(seq).padStart(2, "0")}`, clientId: client.id, subtotalCents: totalCents, totalCents, issueDate: new Date() },
    });
  }

  it("listé, signalé au tableau de bord, rattaché à une facture due (soldée), puis plus signalé", async () => {
    const inv = await issuedInvoice(12_000);
    const payment = await prisma.payment.create({ data: { invoiceId: null, amountCents: 12_000, paidAt: new Date(), method: PaymentMethod.CARD, reference: "pi_orphelin", notes: "Paiement Stripe sans facture : à régulariser" } });
    const listed = (await call("GET", "/api/payments/unattached")).json();
    expect(listed.payments.map((p: { id: string }) => p.id)).toEqual([payment.id]);
    expect(listed.invoices.map((i: { id: string }) => i.id)).toContain(inv.id);
    expect((await call("GET", "/api/dashboard/overview?scope=month")).json().unattachedPayments).toEqual({ count: 1, totalCents: 12_000 });

    const res = await call("POST", `/api/payments/${payment.id}/attach`, { invoiceId: inv.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().invoiceStatus).toBe(InvoiceStatus.PAID);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).invoiceId).toBe(inv.id);
    expect((await call("GET", "/api/dashboard/overview?scope=month")).json().unattachedPayments).toBeNull();
    expect((await call("POST", `/api/payments/${payment.id}/attach`, { invoiceId: inv.id })).statusCode).toBe(409);
  });

  it("paiement supérieur au reste dû : refusé (409), rien n'est rattaché", async () => {
    const inv = await issuedInvoice(5_000);
    const payment = await prisma.payment.create({ data: { invoiceId: null, amountCents: 12_000, paidAt: new Date(), method: PaymentMethod.CARD } });
    const res = await call("POST", `/api/payments/${payment.id}/attach`, { invoiceId: inv.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/dépasse le reste dû/);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).invoiceId).toBeNull();
  });
});

describe("fin programmée et prélèvement bloqué", () => {
  it("« Annuler la fin programmée » : fin retirée, reconduction reprise côté Stripe ; refusé après un rachat signé", async () => {
    const sub = await subscription({ collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_fin", stripeLivemode: false, endDate: new Date(Date.now() + 90 * DAY), stripeCancelAt: new Date(Date.now() + 90 * DAY) });
    const res = await call("POST", `/api/subscriptions/${sub.id}/cancel-scheduled-end`);
    expect(res.statusCode).toBe(200);
    expect(stripeAction).toHaveBeenCalledWith("sub_fin", "keepRenewing", false);
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ endDate: null, stripeCancelAt: null });

    const bought = await subscription({ endDate: new Date(Date.now() + 90 * DAY) });
    await prisma.invoice.create({ data: { documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.ACCEPTED, clientId: bought.clientId, subtotalCents: 1, totalCents: 1, buysOutSubscriptionId: bought.id } });
    const refused = await call("POST", `/api/subscriptions/${bought.id}/cancel-scheduled-end`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Rachat signé/);
  });

  it("« Débloquer » : facture et échéance redeviennent payables ; rien en cours : 409", async () => {
    const client = await createClient();
    const quote = await prisma.invoice.create({ data: { documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.ACCEPTED, clientId: client.id, subtotalCents: 10_000, totalCents: 10_000 } });
    const milestone = await prisma.paymentMilestone.create({ data: { quoteId: quote.id, position: 1, label: "Acompte", percentBps: 3000, amountCents: 3_000, triggerText: "Signature", status: MilestoneStatus.DUE, paymentProcessingAt: new Date(Date.now() - 9 * DAY) } });
    const inv = await prisma.invoice.create({ data: { documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.ACOMPTE, status: InvoiceStatus.ISSUED, number: "F-2026-0899", clientId: client.id, subtotalCents: 3_000, totalCents: 3_000, milestoneId: milestone.id, paymentProcessingAt: new Date(Date.now() - 9 * DAY) } });
    await prisma.paymentMilestone.update({ where: { id: milestone.id }, data: { invoiceId: inv.id } });

    expect((await call("POST", `/api/quotes/${quote.id}/milestones/${milestone.id}/clear-processing`)).statusCode).toBe(200);
    expect((await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: milestone.id } })).paymentProcessingAt).toBeNull();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).paymentProcessingAt).toBeNull();
    expect((await call("POST", `/api/invoices/${inv.id}/clear-processing`)).statusCode).toBe(409);
  });
});
