import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Contrat F5 (/suivi) : billingMode, bloc recurring, QUARTER, engagement des abonnements, offre ONE.
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

const EMAIL = "noe@exemple.fr";
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
    const code = rows.map((r) => parsePayload(outboxPayloadRaw(r)).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (code) return code;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("aucun code");
}

async function login() {
  const client = await createClient({ displayName: "Noé Client", type: "B2C" });
  await prisma.client.update({
    where: { id: client.id },
    data: { firstName: "Noé", lastName: "Client", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) },
  });
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code: await lastCode() } });
  return { clientId: client.id, kz_portal: verify.cookies.find((c) => c.name === "kz_portal")!.value };
}

async function tracking(kz_portal: string) {
  return (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
}

describe("espace client : mode de facturation (contrat F5)", () => {
  it("récurrent trimestriel livré : offre NONE, bloc recurring sans frais, engagement et total sur la durée", async () => {
    const { clientId, kz_portal } = await login();
    const service = await createService({ name: "Maintenance" });
    const quote = await prisma.invoice.create({
      data: {
        clientId, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT, billingMode: "RECURRING",
        subtotalCents: 9000, totalCents: 9000,
        lines: { create: [
          {
            position: 1, description: "Maintenance : trimestriel", quantity: 1, unitPriceCents: 9000, lineTotalCents: 9000,
            isSubscription: true, billingDay: 5, billingInterval: "QUARTER", commitmentMonths: 12, subscriptionStart: "DELIVERY", serviceId: service.id,
          },
        ] },
      },
    });
    await issueQuote(quote.id);

    const doc = (await tracking(kz_portal)).documents.find((d: { id: string }) => d.id === quote.id);
    expect(doc).toMatchObject({
      billingMode: "RECURRING",
      paymentPlanOffer: "NONE",
      recurring: {
        period: "QUARTER", amountCents: 9000, commitmentMonths: 12, periods: 4, totalCommitmentCents: 36000,
        // Facturé à la date anniversaire de la livraison (28/10/2026) : jour inconnu avant, jamais celui de la ligne.
        startsAt: "DELIVERY", billingDay: null,
      },
      subscriptionBilling: { interval: "QUARTER", startsAt: "DELIVERY", amountCents: 9000 },
    });
    expect(doc.subscriptionLines[0]).toMatchObject({ interval: "QUARTER", amountCents: 9000, startsAt: "DELIVERY" });
    expect(doc.recurring).not.toHaveProperty("setupFeeCents");
    expect(doc).not.toHaveProperty("paymentPlans");
    // Pas encore d'abonnement : pas de date de 1re facture.
    expect(doc.recurring).not.toHaveProperty("firstInvoiceOn");

    // Montants masqués : ni prix, ni total.
    await prisma.companySettings.updateMany({ data: { publicTrackingShowAmounts: false } });
    invalidateCompanySettingsCache();
    const masque = (await tracking(kz_portal)).documents.find((d: { id: string }) => d.id === quote.id);
    expect(masque.recurring).toMatchObject({ period: "QUARTER", commitmentMonths: 12, periods: 4 });
    for (const k of ["amountCents", "totalCommitmentCents"]) expect(masque.recurring).not.toHaveProperty(k);
  });

  it("récurrent sans frais : départ à la signature, engagement minimal, puis abonnement exposé avec sa 1re facture", async () => {
    const { clientId, kz_portal } = await login();
    const service = await createService({ name: "Hébergement" });
    const quote = await prisma.invoice.create({
      data: {
        clientId, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT, billingMode: "RECURRING",
        subtotalCents: 2500, totalCents: 2500,
        lines: { create: [{
          position: 1, description: "Hébergement : mensuel", quantity: 1, unitPriceCents: 2500, lineTotalCents: 2500,
          isSubscription: true, billingDay: 1, billingInterval: "MONTH", commitmentMonths: 12, serviceId: service.id,
        }] },
      },
    });
    await issueQuote(quote.id);
    const before = (await tracking(kz_portal)).documents.find((d: { id: string }) => d.id === quote.id);
    expect(before).toMatchObject({
      billingMode: "RECURRING",
      paymentPlanOffer: "NONE",
      recurring: { period: "MONTH", amountCents: 2500, commitmentMonths: 12, periods: 12, totalCommitmentCents: 30000, startsAt: "SIGNATURE", billingDay: null },
    });

    await prisma.emailOutbox.deleteMany();
    await app.inject({ method: "POST", url: `/api/public/quotes/${quote.id}/sign-code`, cookies: { kz_portal } });
    const signed = await app.inject({
      method: "POST",
      url: `/api/public/quotes/${quote.id}/decision`,
      cookies: { kz_portal },
      payload: { decision: "ACCEPT", firstName: "Noé", lastName: "Client", signatureMode: "TYPED", code: await lastCode() },
    });
    expect(signed.statusCode).toBe(200);

    const after = await tracking(kz_portal);
    const doc = after.documents.find((d: { id: string }) => d.id === quote.id);
    expect(doc.recurring.firstInvoiceOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Signé : jour de la 1re facture, date anniversaire de la signature.
    expect(doc.recurring.billingDay).toBe(Number(doc.recurring.firstInvoiceOn.slice(8, 10)));
    expect(after.subscriptions).toHaveLength(1);
    expect(after.subscriptions[0]).toMatchObject({ billingInterval: "MONTH", commitmentMonths: 12, amountCents: 2500, manage: "REQUEST", nonRenewalRequestedAt: null });
    expect(after.subscriptions[0].currentTermEndsAt).toBe(after.subscriptions[0].commitmentEndsAt);
  });

  it("ponctuel : billingMode ONE_OFF sans bloc recurring ; devis antérieur : billingMode null", async () => {
    const { clientId, kz_portal } = await login();
    const mk = (billingMode: string | null) =>
      prisma.invoice.create({
        data: {
          clientId, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT, billingMode,
          subtotalCents: 90000, totalCents: 90000,
          lines: { create: [{ position: 1, description: "Site vitrine", quantity: 1, unitPriceCents: 90000, lineTotalCents: 90000 }] },
        },
      });
    const oneOff = await mk("ONE_OFF");
    const legacy = await mk(null);
    await issueQuote(oneOff.id);
    await issueQuote(legacy.id);
    const docs = (await tracking(kz_portal)).documents;
    const a = docs.find((d: { id: string }) => d.id === oneOff.id);
    const b = docs.find((d: { id: string }) => d.id === legacy.id);
    expect(a.billingMode).toBe("ONE_OFF");
    expect(a).not.toHaveProperty("recurring");
    expect(b.billingMode).toBeNull();
    expect(b).not.toHaveProperty("recurring");
  });
});
