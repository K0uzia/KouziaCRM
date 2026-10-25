import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, PaymentMethod, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parisYmd } from "@/lib/format-fr.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Lot D (audit des documents du 25/10/2026) : chaque test reproduit un défaut relevé avant sa correction.
vi.mock("@/lib/email/send-document-pdf.js", () => ({ sendDocumentPdf: vi.fn(async () => ({ sent: false })) }));
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: async () => false,
}));

const { buildApp } = await import("@/app.js");
const { issueQuote, issueInvoice, acceptQuoteByClient } = await import("@/lib/invoices/transitions.js");
const { markPaidFromOnlinePayment } = await import("@/lib/stripe/mark-paid.js");
const { computeBalanceSummary } = await import("@/lib/invoices/documentFlowService.js");
const { invoiceBalance, BALANCE_INCLUDE } = await import("@/lib/invoices/balance.js");
const { generateDocumentNumber } = await import("@/lib/invoices/numberingService.js");
const { commitmentEndOf } = await import("@/lib/subscriptions/commitment.js");

const ADMIN = "admin-lot-d@kouzia.test";
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
  await resetDb();
  await seedCompanySettings();
  await ensureDefaultLegalClauses();
  await setSettings({ split3Percent1Bps: 3000, split3Percent2Bps: 4000, split3Percent3Bps: 3000, split3MinTotalCents: 50_000, installmentIntervalDays: 30 });
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
});

async function setSettings(data: Record<string, unknown>) {
  await prisma.companySettings.updateMany({ data });
  invalidateCompanySettingsCache();
}

async function draftQuote(opts: { billingMode?: "ONE_OFF" | null; offer: string; lines: Array<{ description: string; unitPriceCents: number; quantity?: number }>; discount?: { type: string; value: number } }) {
  const client = await createClient({ displayName: "Atelier Lot D", type: "B2B" });
  const subtotal = opts.lines.reduce((s, l) => s + l.unitPriceCents * (l.quantity ?? 1), 0);
  const total = opts.discount?.type === "PERCENT" ? subtotal - Math.round((subtotal * opts.discount.value) / 10_000) : subtotal;
  return prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT, clientId: client.id, subtotalCents: subtotal, totalCents: total,
      paymentPlanOffer: opts.offer, billingMode: opts.billingMode ?? null,
      ...(opts.discount ? { discountType: opts.discount.type, discountValue: opts.discount.value } : {}),
      lines: { create: opts.lines.map((l, i) => ({ position: i + 1, description: l.description, quantity: l.quantity ?? 1, unitPriceCents: l.unitPriceCents, lineTotalCents: l.unitPriceCents * (l.quantity ?? 1) })) },
    },
  });
}

const milestonesOf = (quoteId: string) => prisma.paymentMilestone.findMany({ where: { quoteId }, orderBy: { position: "asc" } });
const pay = (milestoneId: string, cents: number, pi: string) => markPaidFromOnlinePayment({ amountCents: cents, method: PaymentMethod.CARD, paymentIntentId: pi, milestoneId });

describe("échéancier figé à l'émission", () => {
  it("pourcentages du 3 fois changés dans les réglages après l'émission : la signature garde ceux du devis émis", async () => {
    const q = await draftQuote({ offer: "CHOICE", lines: [{ description: "Site", unitPriceCents: 100_000 }] });
    await issueQuote(q.id);
    await setSettings({ split3Percent1Bps: 5000, split3Percent2Bps: 2500, split3Percent3Bps: 2500 });
    await acceptQuoteByClient(q.id, "Lou Martin", { source: "ADMIN", paymentPlan: "THREE" });
    expect((await milestonesOf(q.id)).map((m) => m.percentBps)).toEqual([3000, 4000, 3000]);
  });

  it("intervalle des échéances changé après l'émission : les dates suivent celui du devis émis", async () => {
    const q = await draftQuote({ billingMode: "ONE_OFF", offer: "TWO", lines: [{ description: "Site", unitPriceCents: 100_000 }] });
    await issueQuote(q.id);
    await setSettings({ installmentIntervalDays: 10 });
    await acceptQuoteByClient(q.id, "Lou Martin", { source: "ADMIN" });
    const signedAt = (await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).quoteDecidedAt!;
    const second = (await milestonesOf(q.id))[1]!;
    expect(second.dueDate!.getTime() - signedAt.getTime()).toBe(30 * DAY);
  });
});

describe("facture définitive (art. 289 du CGI)", () => {
  it("échéancier en 3 fois déjà en cours (deux factures d'acompte) : la dernière échéance donne une facture de solde qui rappelle les acomptes, reste dû 0", async () => {
    const q = await draftQuote({ billingMode: "ONE_OFF", offer: "THREE", lines: [{ description: "Site", unitPriceCents: 100_000 }] });
    await issueQuote(q.id);
    await acceptQuoteByClient(q.id, "Lou Martin", { source: "ADMIN" });
    const [m1, m2, m3] = await milestonesOf(q.id);
    await pay(m1!.id, m1!.amountCents, "pi_d_1");
    await pay(m2!.id, m2!.amountCents, "pi_d_2");
    const deposits = await prisma.invoice.findMany({ where: { quoteId: q.id, documentType: InvoiceDocumentType.INVOICE }, orderBy: { createdAt: "asc" } });
    expect(deposits.map((i) => i.invoiceType)).toEqual([InvoiceType.ACOMPTE, InvoiceType.ACOMPTE]);

    await pay(m3!.id, m3!.amountCents, "pi_d_3");
    const solde = await prisma.invoice.findFirstOrThrow({ where: { quoteId: q.id, invoiceType: InvoiceType.SOLDE } });
    expect((await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: m3!.id } })).invoiceId).toBe(solde.id);
    const summary = await computeBalanceSummary(q.id);
    expect(summary.acomptes.map((a) => a.number)).toEqual(deposits.map((d) => d.number));
    expect(summary.marketTotalCents).toBe(100_000);
    for (const inv of await prisma.invoice.findMany({ where: { quoteId: q.id, documentType: InvoiceDocumentType.INVOICE }, include: BALANCE_INCLUDE })) {
      expect(invoiceBalance(inv).dueCents).toBe(0);
    }
  });

  it("comptant : facture simple qui reprend exactement les lignes, la remise et les clauses figées du devis", async () => {
    const q = await draftQuote({
      billingMode: "ONE_OFF", offer: "ONE", discount: { type: "PERCENT", value: 1000 },
      lines: [{ description: "Site vitrine", unitPriceCents: 80_000 }, { description: "Logo", unitPriceCents: 10_000, quantity: 2 }],
    });
    await issueQuote(q.id);
    await acceptQuoteByClient(q.id, "Lou Martin", { source: "ADMIN" });
    const [m] = await milestonesOf(q.id);
    await pay(m!.id, m!.amountCents, "pi_d_comptant");
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: q.id }, include: { lines: { orderBy: { position: "asc" } } } });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { quoteId: q.id, documentType: InvoiceDocumentType.INVOICE }, include: { lines: { orderBy: { position: "asc" } }, ...BALANCE_INCLUDE } });
    expect(invoice.invoiceType).toBe(InvoiceType.SIMPLE);
    expect(invoice.status).toBe(InvoiceStatus.PAID);
    expect(invoice.number).toBeTruthy();
    const lineOf = (l: { description: string; quantity: unknown; unitPriceCents: number; lineTotalCents: number }) => [l.description, Number(l.quantity), l.unitPriceCents, l.lineTotalCents];
    expect(invoice.lines.map(lineOf)).toEqual(quote.lines.map(lineOf));
    expect([invoice.discountType, invoice.discountValue, invoice.subtotalCents, invoice.totalCents]).toEqual([quote.discountType, quote.discountValue, quote.subtotalCents, quote.totalCents]);
    expect(quote.legalClausesSnapshot).not.toBeNull();
    expect(invoice.legalClausesSnapshot).toEqual(quote.legalClausesSnapshot);
    expect(invoiceBalance(invoice).dueCents).toBe(0);
  });
});

describe("dates d'émission", () => {
  async function draftInvoice() {
    const client = await createClient({ displayName: "Client des dates" });
    return prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.DRAFT, clientId: client.id, subtotalCents: 10_000, totalCents: 10_000,
        lines: { create: [{ position: 1, description: "Prestation", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 }] },
      },
    });
  }
  const issue = (id: string, payload: object) => app.inject({ method: "POST", url: `/api/invoices/${id}/issue`, headers: { cookie }, payload: { email: { send: false }, ...payload } });

  it("date illisible, future ou antérieure à la dernière facture de la série : refusée (400), rien n'est numéroté", async () => {
    const first = await draftInvoice();
    expect((await issue(first.id, { issueDate: new Date(Date.now() - 2 * DAY).toISOString() })).statusCode).toBe(200);
    const second = await draftInvoice();
    expect((await issue(second.id, { issueDate: "pas une date" })).statusCode).toBe(400);
    expect((await issue(second.id, { issueDate: new Date(Date.now() + 3 * DAY).toISOString() })).statusCode).toBe(400);
    const before = await issue(second.id, { issueDate: new Date(Date.now() - 5 * DAY).toISOString() });
    expect(before.statusCode).toBe(400);
    expect(before.json().error).toMatch(/chronologie/);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: second.id } })).number).toBeNull();
    expect((await issue(second.id, { issueDate: new Date().toISOString() })).statusCode).toBe(200);
  });

  it("avoir daté avant la facture créditée : refusé (400)", async () => {
    const inv = await draftInvoice();
    await issueInvoice(inv.id, new Date());
    const res = await app.inject({
      method: "POST", url: `/api/invoices/${inv.id}/credit-note`, headers: { cookie },
      payload: { amountEuros: 10, reason: "COMMERCIAL_GESTURE", refundMethod: "OTHER", issueDate: new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10), sendEmail: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/facture créditée/);
    expect(await prisma.invoice.count({ where: { documentType: InvoiceDocumentType.CREDIT_NOTE } })).toBe(0);
  });
});

describe("fuseau horaire : calendrier de Paris quel que soit le serveur", () => {
  it("serveur en UTC : pièce émise le 1er janvier à 0 h 30 à Paris numérotée dans la nouvelle année ; fin d'engagement au bon jour", async () => {
    const before = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const allocated = await prisma.$transaction((tx) => generateDocumentNumber("FACTURE", { issueDate: new Date("2026-12-31T23:30:00Z"), tx }));
      expect(allocated.sequenceYear).toBe(2027);
      // 31 mars 0 h 30 à Paris + 1 mois = 30 avril (et non 1er mai).
      expect(parisYmd(commitmentEndOf(new Date("2026-03-30T22:30:00Z"), 1))).toBe("2026-04-30");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

void QuoteStatus;
