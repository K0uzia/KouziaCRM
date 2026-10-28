import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { buildPaymentHistory } from "@/lib/portal/tracking-payload.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// /suivi (audit du 28/10/2026) : montant d'un devis dans le fil, signature d'un devis expiré, devis retiré masqué,
// motif interne jamais envoyé, total dû du contrat retiré (faux dès deux projets).
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

const { buildApp } = await import("@/app.js");

const EMAIL = "camille@exemple.fr";
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

async function lastCode(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const rows = await prisma.emailOutbox.findMany({ orderBy: { createdAt: "desc" } });
    const code = rows.map((r) => parsePayload(outboxPayloadRaw(r)).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (code) return code;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("aucun code");
}

let seq = 0;
async function quote(clientId: string, data: Partial<Parameters<typeof prisma.invoice.create>[0]["data"]>) {
  seq += 1;
  return prisma.invoice.create({
    data: {
      clientId,
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.ISSUED,
      quoteStatus: QuoteStatus.SENT,
      number: `D-2026-90${seq}`,
      issueDate: new Date(),
      subtotalCents: 0,
      totalCents: 0,
      ...data,
    } as Parameters<typeof prisma.invoice.create>[0]["data"],
  });
}

async function tracking() {
  const client = await createClient({ displayName: "Camille Asso", type: "ASSOCIATION" });
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
  const tomorrow = new Date(Date.now() + 86400000);
  const mixed = await quote(client.id, { subtotalCents: 175000, totalCents: 175000, depositBaseCents: 165000, validUntil: tomorrow });
  const expired = await quote(client.id, { subtotalCents: 50000, totalCents: 50000, depositBaseCents: 50000, validUntil: new Date(Date.now() - 86400000) });
  const withdrawn = await quote(client.id, { quoteStatus: QuoteStatus.WITHDRAWN, status: InvoiceStatus.CANCELLED, quoteRejectReason: "Erreur de prix" });
  const cancelled = await quote(client.id, { quoteStatus: QuoteStatus.CANCELLED, status: InvoiceStatus.CANCELLED, quoteRejectReason: "Motif interne", totalCents: 30000, depositBaseCents: 30000 });
  const proposals = await quote(client.id, { subtotalCents: 118800, totalCents: 118800, validUntil: tomorrow });
  await prisma.quoteOption.createMany({
    data: [
      { quoteId: proposals.id, position: 0, label: "A", billingMode: "ONE_OFF", subtotalCents: 165000, totalCents: 165000 },
      { quoteId: proposals.id, position: 1, label: "B", billingMode: "RECURRING", subtotalCents: 9900, totalCents: 9900 },
    ],
  });
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code: await lastCode() } });
  const kz_portal = verify.cookies.find((c) => c.name === "kz_portal")!.value;
  const body = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
  const doc = (id: string) => (body.documents as Array<Record<string, unknown>>).find((d) => d.id === id);
  return { body, doc, mixed, expired, withdrawn, cancelled, proposals };
}

describe("/suivi : montants et décisions des devis", () => {
  it("devis mixte : le montant du fil est le projet ; devis à propositions : aucun montant", async () => {
    const { doc, mixed, proposals } = await tracking();
    expect(doc(mixed.id)).toMatchObject({ totalCents: 165000 });
    expect(doc(proposals.id)).toBeDefined();
    expect(doc(proposals.id)!.totalCents).toBeUndefined();
  });

  it("devis expiré : plus signable ; devis encore valable : signable", async () => {
    const { doc, mixed, expired } = await tracking();
    expect(doc(expired.id)).toMatchObject({ canAcceptQuote: false });
    expect(doc(mixed.id)).toMatchObject({ canAcceptQuote: true });
  });

  it("devis retiré : masqué ; commande annulée : visible sans le motif interne", async () => {
    const { doc, withdrawn, cancelled } = await tracking();
    expect(doc(withdrawn.id)).toBeUndefined();
    expect(doc(cancelled.id)).toMatchObject({ quoteStatus: "CANCELLED", quoteRejectReason: null });
  });

  it("le total dû du contrat n'est plus envoyé (totalNetDueCents fait foi)", async () => {
    const { body } = await tracking();
    expect(body.paymentHistory).not.toHaveProperty("totalDueCents");
    expect(body.paymentHistory).toHaveProperty("totalNetDueCents");
    const h = buildPaymentHistory({ docs: [], milestones: [], showAmounts: true });
    expect(h).not.toHaveProperty("totalDueCents");
  });
});
