import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, SubscriptionStatus } from "@prisma/client";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Contrat R4 (26/10/2026) : remise du devis récurrent (recurring.discount) et de l'abonnement (subscriptions[].discount).
vi.mock("@/lib/email/smtp.js", async (orig) => ({ ...(await orig<typeof import("@/lib/email/smtp.js")>()), isSmtpConfigured: async () => true }));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({ ...(await orig<typeof import("@/lib/email/mailer/index.js")>()), sendOutboxImmediately: async () => true }));

const { buildApp } = await import("@/app.js");
const { issueQuote } = await import("@/lib/invoices/transitions.js");

const EMAIL = "lou@exemple.fr";
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { publicTrackingShowAmounts: true } });
  invalidateCompanySettingsCache();
});

async function lastCode(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const rows = await prisma.emailOutbox.findMany({ orderBy: { createdAt: "desc" } });
    const code = rows.map((r) => parsePayload(outboxPayloadRaw(r)).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (code) return code;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("aucun code");
}

async function setup() {
  const client = await createClient({ displayName: "Lou Remise", type: "B2B" });
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
  const service = await createService({ name: "Site tout compris" });
  const quote = await prisma.invoice.create({
    data: {
      clientId: client.id, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT, subtotalCents: 150000, totalCents: 150000,
      billingMode: "RECURRING", paymentPlanOffer: "NONE",
      recurringDiscountKind: "PERCENT", recurringDiscountValue: 3000, recurringDiscountMonths: 12, openingDiscount: true,
      lines: { create: [{ position: 1, description: "Site tout compris", quantity: 1, unitPriceCents: 150000, lineTotalCents: 150000, isSubscription: true, billingInterval: "YEAR", billingDay: 1, commitmentMonths: 36, serviceId: service.id }] },
    },
  });
  await issueQuote(quote.id);
  await prisma.subscription.create({
    data: {
      clientId: client.id, serviceId: service.id, label: "Site tout compris", amountCents: 150000, billingDay: 1, billingInterval: "YEAR",
      startDate: new Date(), nextInvoiceAt: new Date(Date.now() + 30 * 86_400_000), status: SubscriptionStatus.ACTIVE,
      commitmentMonths: 36, commitmentEndsAt: new Date(Date.now() + 1000 * 86_400_000),
      discountKind: "PERCENT", discountValue: 3000, discountPeriods: 1,
    },
  });
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code: await lastCode() } });
  return { quoteId: quote.id, kz_portal: verify.cookies.find((c) => c.name === "kz_portal")!.value };
}
const tracking = async (kz_portal: string) => (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();

describe("contrat R4 : remise dans /suivi", () => {
  it("devis : recurring.discount et total remisé ; abonnement : discount avec la prochaine échéance remise déduite", async () => {
    const { quoteId, kz_portal } = await setup();
    const t = await tracking(kz_portal);
    const doc = t.documents.find((d: { id: string }) => d.id === quoteId);
    expect(doc.recurring).toMatchObject({ amountCents: 150000, periods: 3, totalCommitmentCents: 405000 });
    expect(doc.recurring.discount).toEqual({ kind: "PERCENT", percentBps: 3000, months: 12, periods: 1, opening: true, discountedAmountCents: 105000 });
    expect(t.subscriptions[0].discount).toEqual({ kind: "PERCENT", percentBps: 3000, remainingPeriods: 1, nextAmountCents: 105000 });
  });

  it("code promo (R3) : promoCode et condition, comme le PDF", async () => {
    const { quoteId, kz_portal } = await setup();
    const code = await prisma.promoCode.create({ data: { code: "OUVERTURE30", kind: "PERCENT", value: 3000, months: 12, conditionText: "structure créée il y a moins de 12 mois" } });
    await prisma.invoice.update({ where: { id: quoteId }, data: { promoCodeId: code.id, openingDiscount: false } });
    const doc = (await tracking(kz_portal)).documents.find((d: { id: string }) => d.id === quoteId);
    expect(doc.recurring.discount).toMatchObject({ promoCode: "OUVERTURE30", condition: "structure créée il y a moins de 12 mois", opening: false, percentBps: 3000 });
  });

  it("montants masqués : pourcentage et durée seulement ; plus de discount une fois les échéances remisées facturées", async () => {
    const { quoteId, kz_portal } = await setup();
    await prisma.companySettings.updateMany({ data: { publicTrackingShowAmounts: false } });
    invalidateCompanySettingsCache();
    let t = await tracking(kz_portal);
    expect(t.documents.find((d: { id: string }) => d.id === quoteId).recurring.discount).toEqual({ kind: "PERCENT", percentBps: 3000, months: 12, periods: 1, opening: true });
    expect(t.subscriptions[0].discount).toEqual({ kind: "PERCENT", percentBps: 3000, remainingPeriods: 1 });
    await prisma.subscription.updateMany({ data: { discountPeriodsBilled: 1 } });
    t = await tracking(kz_portal);
    expect(t.subscriptions[0]).not.toHaveProperty("discount");
  });
});
