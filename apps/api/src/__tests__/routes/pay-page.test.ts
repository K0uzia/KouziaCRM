import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

const createInvoiceCheckoutSession = vi.fn(async () => "https://checkout.stripe.com/c/pay/cs_test_123");
const createSubscriptionCheckoutSession = vi.fn(async () => "https://checkout.stripe.com/c/pay/cs_test_sub");
vi.mock("@/lib/stripe/checkout.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/checkout.js")>()),
  createInvoiceCheckoutSession,
  createSubscriptionCheckoutSession,
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

async function unpaidInvoice(totalCents = 12900) {
  const client = await createClient();
  return prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      number: "F-2026-0042",
      clientId: client.id,
      subtotalCents: totalCents,
      totalCents,
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

  it("POST du navigateur (formulaire urlencoded, corps vide) : 303 vers Stripe, pas de 415", async () => {
    const inv = await unpaidInvoice();
    const res = await app.inject({
      method: "POST",
      url: `/api/public/pay/${signPayToken("invoice", inv.id)}`,
      headers: { origin: "https://api.kouzia.com", "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("https://checkout.stripe.com/c/pay/cs_test_123");
  });

  it("mise en place du prélèvement : même formulaire, envoi réel du navigateur, 303 vers Stripe", async () => {
    const client = await createClient();
    const service = await createService();
    const sub = await prisma.subscription.create({
      data: {
        clientId: client.id,
        serviceId: service.id,
        label: "Maintenance",
        amountCents: 2_900,
        billingDay: 1,
        startDate: new Date(),
        nextInvoiceAt: new Date(Date.now() + 86_400_000),
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/public/subscribe/${signPayToken("subscribe", sub.id)}`,
      headers: { origin: "https://api.kouzia.com", "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("https://checkout.stripe.com/c/pay/cs_test_sub");
  });

  it("montant sous 0,50 € : message et contact, sans bouton ; le POST ne crée pas de session", async () => {
    await prisma.companySettings.updateMany({ data: { email: "contact@kouzia.test" } });
    const inv = await unpaidInvoice(30);
    const url = `/api/public/pay/${signPayToken("invoice", inv.id)}`;
    const get = await app.inject({ method: "GET", url });
    expect(get.body).toContain("Montant inférieur au minimum accepté par le paiement en ligne (0,50");
    expect(get.body).toContain("contact@kouzia.test");
    expect(get.body).not.toContain("<form");
    const post = await app.inject({
      method: "POST",
      url,
      headers: { origin: "https://api.kouzia.com", "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(post.statusCode).toBe(200);
    expect(post.body).toContain("Montant inférieur au minimum");
    expect(createInvoiceCheckoutSession).not.toHaveBeenCalled();
  });

  it("Checkout indisponible : la page l'explique au lieu d'une redirection muette", async () => {
    const inv = await unpaidInvoice();
    createInvoiceCheckoutSession.mockRejectedValueOnce(new Error("Stripe down"));
    const res = await app.inject({
      method: "POST",
      url: `/api/public/pay/${signPayToken("invoice", inv.id)}`,
      headers: { origin: "https://api.kouzia.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Le paiement en ligne n&#39;a pas pu démarrer");
    expect(res.body).toContain("<form");
  });

  it("jeton falsifié : retour à l'espace client, rien de créé", async () => {
    const res = await app.inject({ method: "POST", url: "/api/public/pay/abc.def" });
    expect(res.statusCode).toBe(303);
    expect(createInvoiceCheckoutSession).not.toHaveBeenCalled();
  });
});
