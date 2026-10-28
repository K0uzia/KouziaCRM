/**
 * Liens de paiement de /suivi (décision du 27/10/2026 : Stripe ou ERP seulement, audit du 28/10/2026). L'alerte « lien hors Stripe » affirme
 * « Il n'est pas affiché dans l'espace client » : on vérifie ce que /api/public/tracking renvoie au site.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({ ...(await orig<object>()), isSmtpConfigured: async () => true }));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({ ...(await orig<object>()), sendOutboxImmediately: async () => true }));

const { buildApp } = await import("@/app.js");
const EMAIL = "audit-liens@exemple.test";
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
  invalidateCompanySettingsCache();
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

describe("P1 : lien de paiement hors Stripe enregistré avant le 27/10/2026", () => {
  it("n'est pas renvoyé à /suivi (facture)", async () => {
    const c = await createClient({ displayName: "Client Liens" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
    const inv = await prisma.invoice.create({
      data: {
        clientId: c.id, documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: "F-2026-0901",
        issueDate: new Date(), subtotalCents: 50_000, totalCents: 50_000, checkoutUrl: "https://paiement-pirate.example/payer",
        lines: { create: [{ position: 1, description: "Site", quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000 }] },
      },
    });
    const kz_portal = await login();
    const docs = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json().documents as Array<Record<string, unknown>>;
    const d = docs.find((x) => x.id === inv.id)!;
    expect(d.checkoutUrl ?? null).toBeNull();
  });
});
