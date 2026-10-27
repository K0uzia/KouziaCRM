import { promises as fs } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, MilestoneStatus, PaymentMethod, QuoteStatus, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { createOnboardingToken } from "@/lib/clients/onboarding-token.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Lot E-a (audit du 25/10/2026, P2) : chaque test reproduit un défaut relevé avant sa correction.
const { alertAdmin, sendPaymentReceipt } = vi.hoisted(() => ({
  alertAdmin: vi.fn(async (..._args: unknown[]) => undefined),
  sendPaymentReceipt: vi.fn(async (..._args: unknown[]) => ({ sent: false })),
}));
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));
vi.mock("@/lib/email/payment-receipt.js", () => ({ sendPaymentReceipt }));
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: async () => false,
}));
const CAUCETEY = { name: "3 Chemin de Caucetey", postcode: "33880", city: "Saint-Caprais-de-Bordeaux", citycode: "33381" };
// Base nationale d'adresses simulée ; le reste (WebAssembly du rendu PDF) passe par le vrai fetch.
const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: unknown, init?: unknown) =>
    !String(input instanceof Request ? input.url : input).includes("api-adresse") ? realFetch(input as never, init as never) : new Response(
      JSON.stringify({ features: [{ geometry: { coordinates: [-0.43, 44.76] }, properties: { label: `${CAUCETEY.name} ${CAUCETEY.postcode} ${CAUCETEY.city}`, ...CAUCETEY, score: 0.95, type: "housenumber" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ),
);

const { buildApp } = await import("@/app.js");
const { markMilestonePaidManually } = await import("@/lib/payments/milestonePaymentService.js");
const { generateMilestoneInvoice } = await import("@/lib/invoices/documentFlowService.js");
const { paymentReceiptPdf } = await import("@/lib/pdf/receipt-archive.js");
const { issuedPdfAbsolutePath } = await import("@/lib/pdf/issued-archive.js");
const { generateDueSubscriptionInvoices, nextPeriodDate } = await import("@/lib/subscriptions/subscription-service.js");
const { createBuyoutQuote } = await import("@/lib/subscriptions/buyout.js");
const { buildPaymentHistory } = await import("@/lib/portal/tracking-payload.js");

const ADMIN = "admin-lot-e-a@kouzia.test";
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars!!";
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  alertAdmin.mockClear();
  sendPaymentReceipt.mockClear();
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

let quoteSeq = 0;
async function signedQuoteWithDeposit() {
  const client = await createClient();
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt("client@exemple.fr") } });
  const quote = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: `D-2026-05${String(++quoteSeq).padStart(2, "0")}`, clientId: client.id,
      subtotalCents: 50_000, totalCents: 50_000, quoteStatus: QuoteStatus.ACCEPTED, quoteDecidedAt: new Date(), issueDate: new Date(),
      lines: { create: [{ position: 1, description: "Prestation", quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000 }] },
    },
  });
  const deposit = await prisma.paymentMilestone.create({ data: { quoteId: quote.id, position: 1, label: "Acompte", percentBps: 3000, amountCents: 15_000, triggerText: "Signature", status: MilestoneStatus.DUE } });
  await prisma.paymentMilestone.create({ data: { quoteId: quote.id, position: 2, label: "Solde", percentBps: 7000, amountCents: 35_000, triggerText: "Livraison", status: MilestoneStatus.PENDING } });
  return { client, quote, deposit };
}

describe("acompte réglé à la main", () => {
  it("date du règlement saisie, jalon annulé refusé, reçu au montant réellement encaissé", async () => {
    const { deposit } = await signedQuoteWithDeposit();
    const invoice = await generateMilestoneInvoice(deposit.id);
    // Un premier règlement partiel : le reste dû n'est plus le montant prévu du jalon.
    await prisma.payment.create({ data: { invoiceId: invoice.id, amountCents: 5_000, paidAt: new Date(), method: PaymentMethod.BANK_TRANSFER } });
    const paidAt = new Date("2026-10-20T10:00:00Z");
    await markMilestonePaidManually({ milestoneId: deposit.id, method: PaymentMethod.BANK_TRANSFER, paidAt });
    const payment = await prisma.payment.findFirstOrThrow({ where: { invoiceId: invoice.id, amountCents: 10_000 } });
    expect(payment.paidAt.toISOString()).toBe(paidAt.toISOString());
    expect(sendPaymentReceipt).toHaveBeenCalledWith(invoice.id, 10_000, payment.id, expect.anything());

    const { deposit: other } = await signedQuoteWithDeposit();
    await prisma.paymentMilestone.update({ where: { id: other.id }, data: { status: MilestoneStatus.CANCELLED } });
    await expect(markMilestonePaidManually({ milestoneId: other.id, method: PaymentMethod.CASH })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("règlements saisis sur une facture", () => {
  it("montant arrondi à 0 centime et date illisible : 400 (et non un règlement de 0 ou une erreur 500)", async () => {
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: "F-2026-0500", clientId: client.id,
        subtotalCents: 10_000, totalCents: 10_000, issueDate: new Date(),
        lines: { create: [{ position: 1, description: "Prestation", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 }] },
      },
    });
    const pay = (payload: object) => app.inject({ method: "POST", url: `/api/invoices/${inv.id}/pay`, headers: { cookie }, payload });
    expect((await pay({ amountEuros: 0.001, notifyClient: false })).statusCode).toBe(400);
    expect((await pay({ amountEuros: 10, paidAt: "pas une date", notifyClient: false })).statusCode).toBe(400);
    expect(await prisma.payment.count()).toBe(0);
    const refund = await app.inject({ method: "POST", url: `/api/invoices/${inv.id}/refund`, headers: { cookie }, payload: { amountEuros: 0.004 } });
    expect(refund.statusCode).toBe(400);
  });
});

describe("reçu archivé", () => {
  it("empreinte du reçu différente du fichier : alerte à l'administrateur (comme pour un document émis)", async () => {
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.PAID, number: "F-2026-0501", clientId: client.id,
        subtotalCents: 10_000, totalCents: 10_000, issueDate: new Date(), issuedAt: new Date(),
        lines: { create: [{ position: 1, description: "Prestation", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 }] },
      },
    });
    const payment = await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 10_000, paidAt: new Date(), method: PaymentMethod.BANK_TRANSFER } });
    expect(await paymentReceiptPdf(payment.id)).not.toBeNull();
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    await fs.appendFile(issuedPdfAbsolutePath(row.receiptPdfPath!), "altéré");
    await paymentReceiptPdf(payment.id);
    expect(alertAdmin).toHaveBeenCalledTimes(1);
    expect(String(alertAdmin.mock.calls[0]![1])).toMatch(/SHA-256/);
  });

  it("remboursement : ni règlement dans /suivi, ni reçu archivé", async () => {
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.PAID, number: "F-2026-0502", clientId: client.id,
        subtotalCents: 10_000, totalCents: 10_000, issueDate: new Date(), issuedAt: new Date(),
      },
      include: { payments: true },
    });
    const paid = await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 10_000, paidAt: new Date(), method: PaymentMethod.BANK_TRANSFER } });
    const refund = await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: -3_000, paidAt: new Date(), method: PaymentMethod.BANK_TRANSFER } });
    const doc = { ...inv, payments: [paid, refund] };
    const history = buildPaymentHistory({ docs: [doc] as never, milestones: [], showAmounts: true });
    expect(history.items.map((i) => i.id)).toEqual([`payment-${paid.id}`]);
    const { archivePendingReceipts } = await import("@/lib/pdf/receipt-archive.js");
    await archivePendingReceipts();
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: refund.id } })).receiptPdfPath).toBeNull();
  });
});

describe("abonnements : fins de mois et maintenance", () => {
  it("échéance du 31 : 28 février puis 31 mars (jamais 3 mars et décalage durable)", async () => {
    expect(nextPeriodDate(new Date(2026, 0, 31), 1).getDate()).toBe(28);
    const service = await createService({ name: "Maintenance", isSubscription: true });
    const client = await createClient();
    const sub = await prisma.subscription.create({
      data: { clientId: client.id, serviceId: service.id, label: "Maintenance", amountCents: 3_000, billingDay: 28, billingInterval: "MONTH", startDate: new Date(2026, 0, 31), nextInvoiceAt: new Date(2026, 0, 31) },
    });
    await generateDueSubscriptionInvoices(new Date(2026, 1, 1));
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).nextInvoiceAt).toEqual(new Date(2026, 1, 28));
    await generateDueSubscriptionInvoices(new Date(2026, 2, 1));
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).nextInvoiceAt).toEqual(new Date(2026, 2, 31));
  });

  it("un abonnement en erreur n'empêche pas la facturation des autres", async () => {
    const service = await createService({ name: "Maintenance", isSubscription: true });
    for (const n of [1, 2]) {
      const client = await createClient({ displayName: `Client ${n}` });
      await prisma.subscription.create({
        data: { clientId: client.id, serviceId: service.id, label: `Maintenance ${n}`, amountCents: 3_000, billingDay: 1, billingInterval: "MONTH", startDate: new Date(2026, 0, 1), nextInvoiceAt: new Date(2026, 0, 1) },
      });
    }
    const real = prisma.invoice.findMany.bind(prisma.invoice);
    let calls = 0;
    vi.spyOn(prisma.invoice, "findMany").mockImplementation(((args: never) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("panne simulée"));
      return real(args);
    }) as never);
    await expect(generateDueSubscriptionInvoices(new Date(2026, 0, 2))).resolves.toBe(1);
  });
});

describe("rachat : double clic", () => {
  it("deux demandes simultanées : un seul devis, la seconde reçoit 409", async () => {
    const offer = await prisma.service.create({ data: { name: "Vitrine", unitPriceCents: 36_000, isSubscription: true, billingInterval: "YEAR" } });
    const buyout = await prisma.service.create({ data: { name: "Rachat", unitPriceCents: 75_000 } });
    await prisma.service.update({ where: { id: offer.id }, data: { buyoutServiceId: buyout.id } });
    const client = await createClient();
    const next = new Date();
    next.setMonth(next.getMonth() + 6, 1);
    const sub = await prisma.subscription.create({
      data: {
        clientId: client.id, serviceId: offer.id, label: "Vitrine", amountCents: 36_000, billingDay: 1, billingInterval: "YEAR", startDate: new Date(), nextInvoiceAt: next,
        commitmentMonths: 36, commitmentEndsAt: new Date(next.getFullYear() + 2, next.getMonth(), 1), status: SubscriptionStatus.ACTIVE,
      },
    });
    const results = await Promise.allSettled([createBuyoutQuote(sub.id), createBuyoutQuote(sub.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { statusCode: 409 } });
    expect(await prisma.invoice.count({ where: { buysOutSubscriptionId: sub.id } })).toBe(1);
  });
});

describe("onboarding d'un client existant", () => {
  it("adresse e-mail remplacée par celle de l'invitation : sessions du portail révoquées", async () => {
    const old = "ancienne@exemple.fr";
    const client = await prisma.client.create({ data: { type: "B2C", displayName: "Camille Dupont", lastName: "Dupont", emailEncrypted: encrypt(old), emailHash: computeEmailHash(old) } });
    await prisma.portalSession.create({ data: { clientId: client.id, tokenHash: "c".repeat(64), deviceHash: "d".repeat(64), expiresAt: new Date(Date.now() + 86_400_000) } });
    const email = "nouvelle@exemple.fr";
    const { token, jti, expiresAt } = createOnboardingToken({ email, existingClientId: client.id });
    await prisma.onboardingInvitation.create({ data: { email, token: jti, jti, expiresAt, existingClientId: client.id } });
    const res = await app.inject({
      method: "POST", url: "/api/public/clients",
      payload: { token, type: "B2C", firstName: "Camille", lastName: "Dupont", website: "", country: "FRANCE", addressLine1: CAUCETEY.name, postalCode: CAUCETEY.postcode, city: CAUCETEY.city },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(await prisma.portalSession.count({ where: { clientId: client.id, revokedAt: null } })).toBe(0);
  });
});
