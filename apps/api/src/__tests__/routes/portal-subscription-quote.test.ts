import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// SMTP « configuré » sans envoi réseau : les codes se lisent dans la file.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

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
  await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: true, publicTrackingShowAmounts: true } });
  invalidateCompanySettingsCache();
});
afterEach(async () => {
  await resetDb();
});

async function lastCode(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const rows = await prisma.emailOutbox.findMany({ orderBy: { createdAt: "desc" } });
    const code = rows.map((r) => parsePayload(r.payload).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (code) return code;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("aucun code");
}

async function setup() {
  const client = await createClient({ displayName: "Lou Abonnée", type: "B2C" });
  await prisma.client.update({
    where: { id: client.id },
    data: { firstName: "Lou", lastName: "Abonnée", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) },
  });
  const service = await createService({ name: "Maintenance" });
  const quote = await prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      subtotalCents: 12000,
      totalCents: 12000,
      lines: {
        create: [{
          position: 1, description: "Maintenance : annuel", quantity: 1, unitPriceCents: 12000, lineTotalCents: 12000,
          isSubscription: true, billingDay: 1, billingInterval: "YEAR", serviceId: service.id,
        }],
      },
    },
  });
  await issueQuote(quote.id);
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code: await lastCode() } });
  const kz_portal = verify.cookies.find((c) => c.name === "kz_portal")!.value;
  return { quoteId: quote.id, kz_portal };
}

describe("espace client : devis d'abonnement seul", () => {
  it("expose l'offre NONE sans échéancier, puis le lien de prélèvement à la signature", async () => {
    const { quoteId, kz_portal } = await setup();
    const before = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    const doc = before.documents.find((d: { id: string }) => d.id === quoteId);
    expect(doc).toMatchObject({
      paymentPlanOffer: "NONE",
      paymentPlan: null,
      milestones: [],
      requiresDeposit: false,
      depositPaid: true,
      canAcceptQuote: true,
      subscriptionBilling: { interval: "YEAR", amountCents: 12000 },
    });
    expect(doc.paymentPlans).toBeUndefined();

    // Une formule envoyée par erreur est refusée avant de consommer le code.
    const refused = await app.inject({
      method: "POST",
      url: `/api/public/quotes/${quoteId}/decision`,
      cookies: { kz_portal },
      payload: { decision: "ACCEPT", firstName: "Lou", lastName: "Abonnée", signatureMode: "TYPED", code: "000000", paymentPlan: "TWO" },
    });
    expect(refused.statusCode).toBe(400);

    await prisma.emailOutbox.deleteMany();
    await app.inject({ method: "POST", url: `/api/public/quotes/${quoteId}/sign-code`, cookies: { kz_portal } });
    const signed = await app.inject({
      method: "POST",
      url: `/api/public/quotes/${quoteId}/decision`,
      cookies: { kz_portal },
      payload: { decision: "ACCEPT", firstName: "Lou", lastName: "Abonnée", signatureMode: "TYPED", code: await lastCode() },
    });
    expect(signed.statusCode).toBe(200);
    const body = signed.json();
    expect(body.quoteStatus).toBe("ACCEPTED");
    expect(body.subscriptionSetupUrl).toMatch(/\/api\/public\/subscribe\//);

    const after = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    expect(after.subscriptions).toHaveLength(1);
    expect(after.subscriptions[0]).toMatchObject({ billingInterval: "YEAR", amountCents: 12000, setupUrl: body.subscriptionSetupUrl });
  });
});
