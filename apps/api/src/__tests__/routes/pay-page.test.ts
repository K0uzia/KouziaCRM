import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const createInvoiceCheckoutSession = vi.fn(async () => "https://checkout.stripe.com/c/pay/cs_test_123");
vi.mock("@/lib/stripe/checkout.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/checkout.js")>()),
  createInvoiceCheckoutSession,
}));

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars!!";
const { buildApp } = await import("@/app.js");
const { signPayToken } = await import("@/lib/stripe/pay-token.js");

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
  createInvoiceCheckoutSession.mockClear();
});

async function unpaidInvoice() {
  const client = await createClient();
  return prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      number: "F-2026-0042",
      clientId: client.id,
      subtotalCents: 12900,
      totalCents: 12900,
      issueDate: new Date(),
    },
  });
}

describe("lien de paiement", () => {
  it("GET : page avec le bouton Payer, sans créer de session Stripe (préchargement des antivirus)", async () => {
    const inv = await unpaidInvoice();
    const res = await app.inject({ method: "GET", url: `/api/public/pay/${signPayToken("invoice", inv.id)}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("F-2026-0042");
    expect(res.body).toContain("129,00");
    expect(res.headers["content-security-policy"]).toContain("form-action 'self' https://checkout.stripe.com");
    expect(createInvoiceCheckoutSession).not.toHaveBeenCalled();
  });

  it("POST depuis l'hôte de l'API (formulaire de la page) : redirection 303 vers Stripe Checkout", async () => {
    const inv = await unpaidInvoice();
    const res = await app.inject({
      method: "POST",
      url: `/api/public/pay/${signPayToken("invoice", inv.id)}`,
      headers: { origin: "https://api.kouzia.com" },
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
  });

  it("jeton falsifié : retour à l'espace client, rien de créé", async () => {
    const res = await app.inject({ method: "POST", url: "/api/public/pay/abc.def" });
    expect(res.statusCode).toBe(303);
    expect(createInvoiceCheckoutSession).not.toHaveBeenCalled();
  });
});
