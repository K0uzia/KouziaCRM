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
    const code = rows.map((r) => parsePayload(outboxPayloadRaw(r)).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
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
  it("refus motivé : la date souhaitée remonte sur le devis et dans les notifications", async () => {
    const { quoteId, kz_portal } = await setup();
    const since = new Date(Date.now() - 1000);
    const reason = "Je préfère un prélèvement le 15 du mois.";
    const res = await app.inject({
      method: "POST",
      url: `/api/public/quotes/${quoteId}/decision`,
      cookies: { kz_portal },
      payload: { decision: "REJECT", reason },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().quoteStatus).toBe("REJECTED");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } })).quoteRejectReason).toBe(reason);
    const { listNotifications } = await import("@/lib/notifications/feed.js");
    const items = await listNotifications(since);
    expect(items.some((n) => n.body.includes(reason))).toBe(true);
  });

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
      subscriptionBilling: { interval: "YEAR", amountCents: 12000, directDebit: true, startsAt: "SIGNATURE" },
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
    // Rien n'est dû au titre du devis : l'abonnement facturera chaque période.
    expect(after.paymentHistory.totalDueCents).toBe(0);
    expect(after.subscriptions).toHaveLength(1);
    expect(after.subscriptions[0]).toMatchObject({ billingInterval: "YEAR", amountCents: 12000, setupUrl: body.subscriptionSetupUrl });
  });

  it("devis mixte : échéancier sur la partie ponctuelle, abonnement à la livraison", async () => {
    const { kz_portal } = await setup();
    const client = await prisma.client.findFirstOrThrow({ where: { emailHash: computeEmailHash(EMAIL) } });
    const service = await prisma.service.findFirstOrThrow();
    const quote = await prisma.invoice.create({
      data: {
        clientId: client.id, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT,
        subtotalCents: 71900, totalCents: 71900, paymentPlanOffer: "TWO",
        lines: { create: [
          { position: 1, description: "Site une page", quantity: 1, unitPriceCents: 69000, lineTotalCents: 69000 },
          { position: 2, description: "Maintenance : mensuel", quantity: 1, unitPriceCents: 2900, lineTotalCents: 2900, isSubscription: true, billingDay: 1, serviceId: service.id },
        ] },
      },
    });
    await issueQuote(quote.id);
    const t = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    const doc = t.documents.find((d: { id: string }) => d.id === quote.id);
    expect(doc).toMatchObject({
      paymentPlanOffer: "TWO",
      oneOffTotalCents: 69000,
      subscriptionBilling: { interval: "MONTH", startsAt: "DELIVERY", directDebit: true, amountCents: 2900 },
    });
    expect(doc.paymentPlans[0].milestones.map((m: { amountCents: number }) => m.amountCents)).toEqual([20700, 48300]);
    expect(doc.milestones.map((m: { amountCents: number }) => m.amountCents)).toEqual([20700, 48300]);
    // Sans remise : pas de oneOffDiscountCents.
    expect(doc).not.toHaveProperty("oneOffDiscountCents");
  });

  it("devis mixte remisé : oneOffDiscountCents = remise de la partie ponctuelle ; masqué avec les montants ; rien d'un autre client", async () => {
    const { kz_portal } = await setup();
    const client = await prisma.client.findFirstOrThrow({ where: { emailHash: computeEmailHash(EMAIL) } });
    const service = await prisma.service.findFirstOrThrow();
    const lignes = (sub: string) => [
      { position: 1, description: "Site une page", quantity: 1, unitPriceCents: 69000, lineTotalCents: 69000 },
      { position: 2, description: sub, quantity: 1, unitPriceCents: 2900, lineTotalCents: 2900, isSubscription: true, billingDay: 1, serviceId: service.id },
    ];
    // Remise de 69 € sur la partie ponctuelle (10 %), abonnement au prix plein.
    const quote = await prisma.invoice.create({
      data: {
        clientId: client.id, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT, paymentPlanOffer: "TWO",
        subtotalCents: 71900, totalCents: 65000, discountType: "PERCENT", discountValue: 1000, lines: { create: lignes("Maintenance : mensuel") },
      },
    });
    await issueQuote(quote.id);
    // Devis remisé d'un autre client : jamais visible.
    const autre = await createClient({ displayName: "Autre client" });
    const etranger = await prisma.invoice.create({
      data: {
        clientId: autre.id, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT, paymentPlanOffer: "TWO",
        subtotalCents: 71900, totalCents: 50000, discountType: "FIXED", discountValue: 21900, lines: { create: lignes("Maintenance étrangère") },
      },
    });
    await issueQuote(etranger.id);

    const t = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    const doc = t.documents.find((d: { id: string }) => d.id === quote.id);
    expect(doc).toMatchObject({ oneOffTotalCents: 62100, oneOffDiscountCents: 6900 });
    expect(t.documents.some((d: { id: string }) => d.id === etranger.id)).toBe(false);
    expect(JSON.stringify(t)).not.toContain("Maintenance étrangère");
    expect(JSON.stringify(t)).not.toContain("21900");

    await prisma.companySettings.updateMany({ data: { publicTrackingShowAmounts: false } });
    invalidateCompanySettingsCache();
    const masque = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    expect(masque.documents.find((d: { id: string }) => d.id === quote.id)).not.toHaveProperty("oneOffDiscountCents");
  });
});
