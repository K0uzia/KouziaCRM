import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

const { buildApp } = await import("@/app.js");

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
  await prisma.companySettings.updateMany({
    data: { bankIban: "FR7630006000011234567890189", bankBic: "AGRIFRPP", bankAccountHolder: "Kouzia EI" },
  });
  invalidateCompanySettingsCache();
});
afterEach(async () => {
  await resetDb();
});

async function login() {
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  let code: string | undefined;
  for (let i = 0; i < 50 && !code; i++) {
    const rows = await prisma.emailOutbox.findMany();
    code = rows.map((r) => parsePayload(outboxPayloadRaw(r)).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (!code) await new Promise((ok) => setTimeout(ok, 20));
  }
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code } });
  return verify.cookies.find((c) => c.name === "kz_portal")!.value;
}

let seq = 0;
async function invoice(clientId: string, data: { status?: InvoiceStatus; checkoutUrl?: string | null; paidCents?: number } = {}) {
  seq++;
  const inv = await prisma.invoice.create({
    data: {
      clientId,
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: data.status ?? InvoiceStatus.ISSUED,
      number: `F-2026-00${seq}`,
      issueDate: new Date(),
      subtotalCents: 50_000,
      totalCents: 50_000,
      checkoutUrl: data.checkoutUrl ?? null,
      lines: { create: [{ position: 1, description: "Site", quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000 }] },
    },
  });
  if (data.paidCents) await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: data.paidCents, paidAt: new Date() } });
  return inv;
}

async function documents() {
  const kz_portal = await login();
  return ((await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json().documents) as Array<Record<string, unknown>>;
}

describe("/suivi : payer une facture (ajout du 19/10/2026)", () => {
  it("facture émise avec lien : checkoutUrl, milestoneId, virement en secours ; lien de l'ERP : moyen principal « sepa_debit »", async () => {
    const c = await createClient({ displayName: "Lou Martin" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
    const pasted = await invoice(c.id, { checkoutUrl: "https://pay.example.test/lien-colle" });
    const erp = await invoice(c.id);
    // Lien signé avec une échéance à la seconde : comparé à la valeur enregistrée, pas recalculé.
    const erpUrl = buildPayUrl("invoice", erp.id);
    await prisma.invoice.update({ where: { id: erp.id }, data: { checkoutUrl: erpUrl } });

    const docs = await documents();
    const a = docs.find((d) => d.id === pasted.id)!;
    expect(a).toMatchObject({
      checkoutUrl: "https://pay.example.test/lien-colle",
      milestoneId: null,
      bankTransfer: { reference: pasted.number, iban: "FR76 3000 6000 0112 3456 7890 189", bic: "AGRIFRPP", accountHolder: "Kouzia EI" },
    });
    expect("paymentMethodHint" in a).toBe(false);
    const b = docs.find((d) => d.id === erp.id)!;
    expect(b.checkoutUrl).toBe(erpUrl);
    expect(b.paymentMethodHint).toBe("sepa_debit");
  });

  it("prélèvement en cours : paymentProcessing, plus de bouton Payer ; SEPA coupé : moyen « card » sous le seuil", async () => {
    const c = await createClient({ displayName: "Lou Martin" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
    const pending = await invoice(c.id, { checkoutUrl: "https://pay.example.test/en-cours" });
    const since = new Date("2026-10-19T09:00:00Z");
    await prisma.invoice.update({ where: { id: pending.id }, data: { paymentProcessingAt: since, paymentProcessingMethod: "sepa_debit" } });
    const small = await invoice(c.id);
    await prisma.invoice.update({ where: { id: small.id }, data: { checkoutUrl: buildPayUrl("invoice", small.id), totalCents: 20_000, subtotalCents: 20_000 } });
    await prisma.companySettings.updateMany({ data: { paymentSepaEnabled: false } });
    invalidateCompanySettingsCache();

    const docs = await documents();
    const p = docs.find((d) => d.id === pending.id)!;
    expect(p.paymentProcessing).toEqual({ since: since.toISOString(), method: "sepa_debit" });
    expect(p.checkoutUrl).toBeUndefined();
    expect(p.bankTransfer).toBeDefined();
    expect(docs.find((d) => d.id === small.id)!.paymentMethodHint).toBe("card");
  });

  it("échéance de devis prélevée avant facturation : paymentProcessing et plus de lien (ajout du 20/10/2026)", async () => {
    const c = await createClient({ displayName: "Lou Martin" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
    const since = new Date("2026-10-20T09:00:00Z");
    const quote = await prisma.invoice.create({
      data: {
        clientId: c.id,
        documentType: InvoiceDocumentType.QUOTE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        quoteStatus: "ACCEPTED",
        number: "D-2026-0099",
        issueDate: new Date(),
        subtotalCents: 100_000,
        totalCents: 100_000,
        milestones: {
          create: [
            { position: 1, label: "Acompte", percentBps: 3000, amountCents: 30_000, triggerText: "À la signature", status: "DUE", checkoutUrl: "https://pay.example.test/acompte", paymentProcessingAt: since, paymentProcessingMethod: "sepa_debit" },
            { position: 2, label: "Solde", percentBps: 7000, amountCents: 70_000, triggerText: "À la livraison", status: "DUE", checkoutUrl: "https://pay.example.test/solde" },
          ],
        },
      },
    });
    const milestones = (await documents()).find((d) => d.id === quote.id)!.milestones as Array<Record<string, unknown>>;
    expect(milestones[0]).toMatchObject({ checkoutUrl: null, paymentProcessing: { since: since.toISOString(), method: "sepa_debit" } });
    expect(milestones[1]).toMatchObject({ checkoutUrl: "https://pay.example.test/solde" });
    expect("paymentProcessing" in milestones[1]!).toBe(false);
  });

  it("sans lien : virement seulement ; payée, annulée ou soldée : ni lien ni virement ; lien non https : ignoré", async () => {
    const c = await createClient({ displayName: "Lou Martin" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
    const plain = await invoice(c.id);
    const paid = await invoice(c.id, { status: InvoiceStatus.PAID, checkoutUrl: "https://pay.example.test/x" });
    const settled = await invoice(c.id, { checkoutUrl: "https://pay.example.test/y", paidCents: 50_000 });
    const unsafe = await invoice(c.id, { checkoutUrl: "javascript:alert(1)" });

    const docs = await documents();
    const byId = (id: string) => docs.find((d) => d.id === id)!;
    expect(byId(plain.id).checkoutUrl).toBeUndefined();
    expect(byId(plain.id).bankTransfer).toMatchObject({ reference: plain.number });
    for (const d of [byId(paid.id), byId(settled.id)]) {
      expect(d.checkoutUrl).toBeUndefined();
      expect(d.bankTransfer).toBeUndefined();
    }
    expect(byId(unsafe.id).checkoutUrl).toBeUndefined();
    expect(byId(unsafe.id).bankTransfer).toBeDefined();
  });

  it("IBAN absent des réglages : pas de bloc virement", async () => {
    await prisma.companySettings.updateMany({ data: { bankIban: null } });
    invalidateCompanySettingsCache();
    const c = await createClient({ displayName: "Lou Martin" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
    const inv = await invoice(c.id);
    expect((await documents()).find((d) => d.id === inv.id)!.bankTransfer).toBeUndefined();
  });
});
