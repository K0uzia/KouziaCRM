import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { startAfterWithdrawal } from "@/lib/quotes/withdrawal.js";
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
const { issueQuote, acceptQuoteByClient } = await import("@/lib/invoices/transitions.js");

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
afterEach(async () => {
  await resetDb();
});

async function settings(data: Parameters<typeof prisma.companySettings.updateMany>[0]["data"]) {
  await prisma.companySettings.updateMany({ data });
  invalidateCompanySettingsCache();
}

async function lastCode(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const rows = await prisma.emailOutbox.findMany({ orderBy: { createdAt: "desc" } });
    const code = rows.map((r) => parsePayload(outboxPayloadRaw(r)).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (code) return code;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("aucun code");
}

/** Devis d'abonnement mensuel seul, émis, et session de l'espace client. */
async function setup(type: "B2C" | "B2B" = "B2C") {
  const client = await createClient({ displayName: "Lou Cliente", type });
  await prisma.client.update({
    where: { id: client.id },
    data: { firstName: "Lou", lastName: "Cliente", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) },
  });
  const service = await createService({ name: "Maintenance" });
  const quote = await prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      subtotalCents: 2900,
      totalCents: 2900,
      lines: {
        create: [{
          position: 1, description: "Maintenance : mensuel", quantity: 1, unitPriceCents: 2900, lineTotalCents: 2900,
          isSubscription: true, billingDay: 1, billingInterval: "MONTH", serviceId: service.id,
        }],
      },
    },
  });
  await issueQuote(quote.id);
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code: await lastCode() } });
  const kz_portal = verify.cookies.find((c) => c.name === "kz_portal")!.value;
  return { quoteId: quote.id, clientId: client.id, kz_portal };
}

async function signCode(quoteId: string, kz_portal: string) {
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: `/api/public/quotes/${quoteId}/sign-code`, cookies: { kz_portal } });
  return lastCode();
}

function decide(quoteId: string, kz_portal: string, extra: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/public/quotes/${quoteId}/decision`,
    cookies: { kz_portal },
    payload: { decision: "ACCEPT", firstName: "Lou", lastName: "Cliente", signatureMode: "TYPED", ...extra },
  });
}

const proofOf = (quoteId: string) => prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId } });

describe("signature en ligne : CGV et droit de rétractation", () => {
  it("particulier sans demande anticipée : délai de 14 jours, abonnement et prélèvement après le délai", async () => {
    const { quoteId, clientId, kz_portal } = await setup("B2C");
    const before = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    expect(before.consumer).toBe(true);
    expect(before.signatureTerms.cgv).toBeNull();
    expect(before.signatureTerms.expressExecutionText).toMatch(/avant la fin du délai de rétractation/);

    const res = await decide(quoteId, kz_portal, { code: await signCode(quoteId, kz_portal) });
    expect(res.statusCode).toBe(200);
    const proof = await proofOf(quoteId);
    expect(proof).toMatchObject({ consumer: true, expressExecution: false, cgvAccepted: false, cgvUrl: null });
    expect(proof.withdrawalEndsAt!.getTime() - proof.createdAt.getTime()).toBeGreaterThan(13 * 86_400_000);

    // Sans Stripe : aucune facture d'abonnement émise à la signature, 1re échéance au lendemain du délai.
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId } });
    expect(sub.nextInvoiceAt.toISOString()).toBe(startAfterWithdrawal(proof.withdrawalEndsAt!).toISOString());
    expect(await prisma.invoice.count({ where: { clientId, documentType: "INVOICE" } })).toBe(0);

    const after = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    const doc = after.documents.find((d: { id: string }) => d.id === quoteId);
    expect(doc.withdrawal).toMatchObject({ expressExecution: false });
    expect(new Date(doc.withdrawal.startsNotBefore).toISOString()).toBe(sub.nextInvoiceAt.toISOString());
    // Contrat KouziaWebsite (README, Espace client) : une entrée par ligne d'abonnement, départ par défaut du devis.
    expect(doc.subscriptionLines).toEqual([expect.objectContaining({ interval: "MONTH", startsAt: "SIGNATURE" })]);
    expect(doc.subscriptionLines[0]).not.toHaveProperty("freeMonths");
  });

  it("avec Stripe : lien de prélèvement tout de suite, 1re échéance (trial_end) après le délai", async () => {
    await settings({ moduleStripeEnabled: true });
    const { quoteId, clientId, kz_portal } = await setup("B2C");
    const res = await decide(quoteId, kz_portal, { code: await signCode(quoteId, kz_portal) });
    expect(res.statusCode).toBe(200);
    expect(res.json().subscriptionSetupUrl).toContain("/api/public/subscribe/");
    const proof = await proofOf(quoteId);
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId } });
    expect(sub.collectionMethod).toBe("STRIPE");
    expect(sub.nextInvoiceAt.toISOString()).toBe(startAfterWithdrawal(proof.withdrawalEndsAt!).toISOString());
  });

  it("particulier avec demande d'exécution anticipée : démarrage immédiat", async () => {
    const { quoteId, clientId, kz_portal } = await setup("B2C");
    const res = await decide(quoteId, kz_portal, { code: await signCode(quoteId, kz_portal), expressExecution: true });
    expect(res.statusCode).toBe(200);
    expect(await proofOf(quoteId)).toMatchObject({ consumer: true, expressExecution: true });
    // Sans Stripe : 1re période facturée tout de suite (la prochaine échéance avance d'un mois).
    expect(await prisma.invoice.count({ where: { clientId, documentType: "INVOICE" } })).toBe(1);
    const doc = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } }))
      .json()
      .documents.find((d: { id: string }) => d.id === quoteId);
    expect(doc.withdrawal).toMatchObject({ expressExecution: true, startsNotBefore: null });
  });

  it("professionnel : pas de délai, et la demande d'exécution anticipée est refusée", async () => {
    const { quoteId, kz_portal } = await setup("B2B");
    const t = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    expect(t.consumer).toBe(false);
    expect(t.signatureTerms.expressExecutionText).toBeNull();
    const refused = await decide(quoteId, kz_portal, { code: "000000", expressExecution: true });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("EXPRESS_EXECUTION_CONSUMER_ONLY");
    const ok = await decide(quoteId, kz_portal, { code: await signCode(quoteId, kz_portal) });
    expect(ok.statusCode).toBe(200);
    expect(await proofOf(quoteId)).toMatchObject({ consumer: false, expressExecution: null, withdrawalEndsAt: null });
  });

  it("CGV publiées : acceptation et version exigées avant le code, puis enregistrées dans la preuve", async () => {
    await settings({ cgvPublished: true, cgvUrl: "https://kouzia.com/cgv", cgvVersion: "2026-11-04" });
    const { quoteId, kz_portal } = await setup("B2C");
    const t = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    expect(t.signatureTerms.cgv).toEqual({ url: "https://kouzia.com/cgv", version: "2026-11-04" });

    const code = await signCode(quoteId, kz_portal);
    const missing = await decide(quoteId, kz_portal, { code });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("CGV_REQUIRED");
    const stale = await decide(quoteId, kz_portal, { code, acceptCgv: true, cgvVersion: "2026-10-01" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("CGV_VERSION_CHANGED");
    // Le code n'a pas été consommé par les refus.
    const ok = await decide(quoteId, kz_portal, { code, acceptCgv: true, cgvVersion: "2026-11-04", expressExecution: true });
    expect(ok.statusCode).toBe(200);
    expect(await proofOf(quoteId)).toMatchObject({
      cgvAccepted: true,
      cgvUrl: "https://kouzia.com/cgv",
      cgvVersion: "2026-11-04",
      expressExecution: true,
    });
  });

  it("signature hors espace client : CGV non acceptées en ligne, particulier sans exécution anticipée", async () => {
    await settings({ cgvPublished: true, cgvUrl: "https://kouzia.com/cgv", cgvVersion: "2026-11-04" });
    const { quoteId } = await setup("B2C");
    await acceptQuoteByClient(quoteId, "Lou Cliente", { source: "ADMIN", cgvAccepted: true, expressExecution: true });
    expect(await proofOf(quoteId)).toMatchObject({
      source: "ADMIN",
      cgvAccepted: false,
      cgvUrl: null,
      consumer: true,
      expressExecution: false,
    });
  });
});
