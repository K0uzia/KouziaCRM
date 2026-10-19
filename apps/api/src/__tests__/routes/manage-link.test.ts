import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SubscriptionCollectionMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

const retrieve = vi.fn(async (_id: string, _params?: unknown): Promise<unknown> => ({}));
const createSession = vi.fn(async (_params: unknown) => ({ url: "https://billing.stripe.com/p/session/test_123" }));
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => ({ subscriptions: { retrieve }, billingPortal: { sessions: { create: createSession } } })),
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
  await prisma.companySettings.updateMany({
    data: { moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake") },
  });
  invalidateCompanySettingsCache();
  retrieve.mockReset();
  createSession.mockClear();
});

async function stripeSub(stripeSubscriptionId: string | null = "sub_manage") {
  const client = await createClient();
  const service = await createService();
  return prisma.subscription.create({
    data: {
      clientId: client.id,
      serviceId: service.id,
      label: "Maintenance",
      amountCents: 4_900,
      billingDay: 1,
      startDate: new Date(),
      nextInvoiceAt: new Date(Date.now() + 86_400_000),
      collectionMethod: SubscriptionCollectionMethod.STRIPE,
      stripeSubscriptionId,
    },
  });
}

const post = (url: string) =>
  app.inject({
    method: "POST",
    url,
    headers: { origin: "https://api.kouzia.com", "content-type": "application/x-www-form-urlencoded" },
    payload: "",
  });

describe("lien de gestion d'un abonnement prélevé (/api/public/manage)", () => {
  it("jeton court : même lien par /manage et /card, redirection vers Stripe ; jeton court inconnu : retour à l'espace client", async () => {
    const sub = await stripeSub();
    const { subscriptionPaymentUrl, subscriptionCardUpdateUrl } = await import("@/lib/stripe/portal.js");
    const manageUrl = await subscriptionPaymentUrl(sub);
    const cardUrl = await subscriptionCardUpdateUrl(sub);
    const token = manageUrl.split("/").pop()!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(cardUrl.endsWith(`/api/public/card/${token}`)).toBe(true);
    expect(await subscriptionPaymentUrl(sub)).toBe(manageUrl);

    // GET (décision du 19/10/2026) : redirection 303 vers le portail Stripe, sans page.
    retrieve.mockResolvedValueOnce({ status: "active", customer: "cus_1", latest_invoice: { status: "paid" } });
    const manage = await app.inject({ method: "GET", url: `/api/public/manage/${token}` });
    expect(manage.statusCode).toBe(303);
    expect(manage.headers.location).toBe("https://billing.stripe.com/p/session/test_123");
    retrieve.mockResolvedValueOnce({ status: "active", customer: "cus_1", latest_invoice: null });
    const card = await app.inject({ method: "GET", url: `/api/public/card/${token}` });
    expect(card.statusCode).toBe(303);

    retrieve.mockResolvedValueOnce({ status: "active", customer: "cus_1", latest_invoice: null });
    const post = await app.inject({
      method: "POST",
      url: `/api/public/card/${token}`,
      headers: { origin: "https://api.kouzia.com", "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(post.statusCode).toBe(303);
    expect(createSession.mock.calls.at(-1)![0]).toMatchObject({ flow_data: { type: "payment_method_update" } });

    const unknown = await app.inject({ method: "GET", url: "/api/public/manage/AAAAAAAAAAAAAAAAAAAAAA" });
    expect(unknown.statusCode).toBe(303);
    expect(unknown.headers.location).not.toContain("stripe.com");
  });

  it("GET : redirection 303 vers le portail Stripe, session créée avec une clé d'idempotence du jour", async () => {
    const sub = await stripeSub();
    retrieve.mockResolvedValueOnce({ status: "active", customer: "cus_1", latest_invoice: { status: "paid" } });
    const res = await app.inject({ method: "GET", url: `/api/public/manage/${signPayToken("manage", sub.id)}` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("https://billing.stripe.com/p/session/test_123");
    expect((createSession.mock.calls[0] as unknown[])[1]).toMatchObject({ idempotencyKey: expect.stringMatching(/^kouzia:portal:\d{4}-\d{2}-\d{2}:/) });
  });

  it("POST, abonnement à jour : accueil du portail client", async () => {
    const sub = await stripeSub();
    retrieve.mockResolvedValueOnce({ status: "active", customer: "cus_1", latest_invoice: { status: "paid" } });
    const res = await post(`/api/public/manage/${signPayToken("manage", sub.id)}`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("https://billing.stripe.com/p/session/test_123");
    expect(createSession.mock.calls[0]![0]).not.toHaveProperty("flow_data");
  });

  it("POST, en retard avec nouvelle tentative : portail sur le changement de moyen de paiement", async () => {
    const sub = await stripeSub();
    retrieve.mockResolvedValueOnce({
      status: "past_due",
      customer: "cus_1",
      latest_invoice: { status: "open", next_payment_attempt: 1_900_000_000, hosted_invoice_url: "https://invoice.stripe.com/i/x" },
    });
    await post(`/api/public/manage/${signPayToken("manage", sub.id)}`);
    expect(createSession.mock.calls[0]![0]).toMatchObject({ customer: "cus_1", flow_data: { type: "payment_method_update" } });
  });

  it("POST, échéance ouverte sans nouvelle tentative (SEPA) : page de paiement de la facture", async () => {
    const sub = await stripeSub();
    retrieve.mockResolvedValueOnce({
      status: "past_due",
      customer: "cus_1",
      latest_invoice: { status: "open", next_payment_attempt: null, hosted_invoice_url: "https://invoice.stripe.com/i/x" },
    });
    const res = await post(`/api/public/manage/${signPayToken("manage", sub.id)}`);
    expect(res.headers.location).toBe("https://invoice.stripe.com/i/x");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("abonnement sans Stripe ou jeton d'un autre type : retour à l'espace client", async () => {
    const sub = await stripeSub(null);
    const res = await post(`/api/public/manage/${signPayToken("manage", sub.id)}`);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).not.toContain("stripe.com");
    const other = await post(`/api/public/manage/${signPayToken("subscribe", sub.id)}`);
    expect(other.headers.location).not.toContain("stripe.com");
  });
});
