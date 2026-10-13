import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));
const createSubscriptionPortalUrl = vi.fn(async (_id: string) => "https://billing.stripe.com/p/session/test_suivi");
vi.mock("@/lib/stripe/portal.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/portal.js")>()),
  createSubscriptionPortalUrl,
}));

const { buildApp } = await import("@/app.js");

const EMAIL = "lou@exemple.fr";
const ADMIN = "admin@kouzia.test";
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
    data: { moduleStripeEnabled: true, publicTrackingShowAmounts: true, email: ADMIN },
  });
  invalidateCompanySettingsCache();
  createSubscriptionPortalUrl.mockClear();
});
afterEach(async () => {
  await resetDb();
});

async function outboxSubjects(to?: string): Promise<string[]> {
  const rows = await prisma.emailOutbox.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((r) => parsePayload(r.payload)).filter((p) => !to || p.to === to).map((p) => p.subject);
}

async function login(email = EMAIL) {
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email } });
  let code: string | undefined;
  for (let i = 0; i < 50 && !code; i++) {
    code = (await outboxSubjects()).map((s) => s.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (!code) await new Promise((ok) => setTimeout(ok, 20));
  }
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email, code } });
  await prisma.emailOutbox.deleteMany();
  return verify.cookies.find((c) => c.name === "kz_portal")!.value;
}

async function clientWith(email: string, name: string) {
  const c = await createClient({ displayName: name, type: "B2C" });
  await prisma.client.update({
    where: { id: c.id },
    data: { firstName: name.split(" ")[0], emailEncrypted: encrypt(email), emailHash: computeEmailHash(email) },
  });
  return c;
}

async function subscription(clientId: string, data: Record<string, unknown> = {}) {
  const service = await createService({ name: "Maintenance" });
  return prisma.subscription.create({
    data: {
      clientId,
      serviceId: service.id,
      label: "Maintenance annuelle",
      amountCents: 59_000,
      billingDay: 1,
      billingInterval: "YEAR",
      startDate: new Date(2026, 0, 1),
      nextInvoiceAt: new Date(2027, 0, 1),
      ...data,
    },
  });
}

const stripe = { collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_suivi" };

describe("/suivi : gestion des abonnements", () => {
  it("payload : prélevé par Stripe → portail, date limite de reconduction ; clôturé jamais affiché", async () => {
    const c = await clientWith(EMAIL, "Lou Martin");
    const sub = await subscription(c.id, stripe);
    await subscription(c.id, { status: SubscriptionStatus.ENDED, label: "Ancien" });
    const kz_portal = await login();
    const t = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    expect(t.subscriptions).toHaveLength(1);
    expect(t.subscriptions[0]).toMatchObject({
      id: sub.id,
      status: "ACTIVE",
      paymentIssue: null,
      cancelAt: null,
      cancellationRequestedAt: null,
      manage: "STRIPE_PORTAL",
      renewalDeadline: new Date(2026, 11, 31).toISOString(),
    });
    expect(t.subscriptions[0].setupUrl).toBeUndefined();
  });

  it("payload : retard, impayé (suspendu) et résiliation programmée gardent le portail", async () => {
    const c = await clientWith(EMAIL, "Lou Martin");
    await subscription(c.id, { ...stripe, stripeSubscriptionId: "sub_a", stripeStatus: "past_due", label: "A" });
    await subscription(c.id, { ...stripe, stripeSubscriptionId: "sub_b", stripeStatus: "unpaid", status: SubscriptionStatus.PAUSED, label: "B" });
    await subscription(c.id, { ...stripe, stripeSubscriptionId: "sub_c", stripeCancelAt: new Date(2027, 0, 1), label: "C" });
    const kz_portal = await login();
    const subs = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json().subscriptions;
    const by = (l: string) => subs.find((s: { label: string }) => s.label === l);
    expect(by("A")).toMatchObject({ paymentIssue: "LATE", manage: "STRIPE_PORTAL", status: "ACTIVE" });
    expect(by("B")).toMatchObject({ paymentIssue: "UNPAID", manage: "STRIPE_PORTAL", status: "PAUSED" });
    expect(by("C")).toMatchObject({ cancelAt: new Date(2027, 0, 1).toISOString(), manage: "STRIPE_PORTAL" });
    expect(by("C").renewalDeadline).toBeUndefined();
  });

  it("portail : URL de session pour son abonnement ; 404 identique pour celui d'un autre ; 409 par virement", async () => {
    const c = await clientWith(EMAIL, "Lou Martin");
    const mine = await subscription(c.id, stripe);
    const transfer = await subscription(c.id, { label: "Virement" });
    const other = await clientWith("autre@exemple.fr", "Sam Autre");
    const theirs = await subscription(other.id, { ...stripe, stripeSubscriptionId: "sub_autre" });
    const kz_portal = await login();

    const ok = await app.inject({ method: "POST", url: `/api/public/subscriptions/${mine.id}/portal`, cookies: { kz_portal } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ url: "https://billing.stripe.com/p/session/test_suivi" });

    const foreign = await app.inject({ method: "POST", url: `/api/public/subscriptions/${theirs.id}/portal`, cookies: { kz_portal } });
    const missing = await app.inject({ method: "POST", url: "/api/public/subscriptions/inexistant/portal", cookies: { kz_portal } });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());

    const manual = await app.inject({ method: "POST", url: `/api/public/subscriptions/${transfer.id}/portal`, cookies: { kz_portal } });
    expect(manual.statusCode).toBe(409);

    createSubscriptionPortalUrl.mockRejectedValueOnce(new Error("No configuration provided"));
    const down = await app.inject({ method: "POST", url: `/api/public/subscriptions/${mine.id}/portal`, cookies: { kz_portal } });
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toContain("indisponible");

    const anonymous = await app.inject({ method: "POST", url: `/api/public/subscriptions/${mine.id}/portal` });
    expect(anonymous.statusCode).toBe(401);
  });

  it("demande de résiliation (virement) : une fois, accusé au client, alerte admin, puis plus de bouton", async () => {
    const c = await clientWith(EMAIL, "Lou Martin");
    const sub = await subscription(c.id);
    const kz_portal = await login();
    const before = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    expect(before.subscriptions[0]).toMatchObject({ manage: "REQUEST" });
    // Mise en place du prélèvement possible et résiliation demandable en même temps.
    expect(before.subscriptions[0].setupUrl).toBeDefined();

    const res = await app.inject({ method: "POST", url: `/api/public/subscriptions/${sub.id}/cancel-request`, cookies: { kz_portal }, payload: {} });
    expect(res.statusCode).toBe(200);
    const at = res.json().cancellationRequestedAt;
    expect(typeof at).toBe("string");
    expect(await outboxSubjects(EMAIL)).toEqual(["Demande de résiliation reçue : Maintenance annuelle"]);
    expect(await outboxSubjects(ADMIN)).toEqual(["Demande de résiliation : Lou Martin"]);

    const again = await app.inject({ method: "POST", url: `/api/public/subscriptions/${sub.id}/cancel-request`, cookies: { kz_portal }, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain("déjà enregistrée");

    const after = (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json();
    expect(after.subscriptions[0]).toMatchObject({ manage: null, cancellationRequestedAt: at });
    expect(after.subscriptions[0].setupUrl).toBeUndefined();
    expect(after.subscriptions[0].renewalDeadline).toBeUndefined();
  });

  it("demande de résiliation refusée pour un abonnement Stripe ou d'un autre client", async () => {
    const c = await clientWith(EMAIL, "Lou Martin");
    const stripeSub = await subscription(c.id, stripe);
    const other = await clientWith("autre@exemple.fr", "Sam Autre");
    const theirs = await subscription(other.id);
    const kz_portal = await login();
    const viaStripe = await app.inject({ method: "POST", url: `/api/public/subscriptions/${stripeSub.id}/cancel-request`, cookies: { kz_portal }, payload: {} });
    expect(viaStripe.statusCode).toBe(409);
    expect(viaStripe.json().error).toContain("Gérer mon abonnement");
    const foreign = await app.inject({ method: "POST", url: `/api/public/subscriptions/${theirs.id}/cancel-request`, cookies: { kz_portal }, payload: {} });
    expect(foreign.statusCode).toBe(404);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: theirs.id } })).cancellationRequestedAt).toBeNull();
  });

  it("limite de débit : message lisible en français", async () => {
    const c = await clientWith(EMAIL, "Lou Martin");
    const sub = await subscription(c.id);
    const kz_portal = await login();
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({ method: "POST", url: `/api/public/subscriptions/${sub.id}/cancel-request`, cookies: { kz_portal }, payload: {} });
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.json().error).toBe("Trop de demandes : réessayez dans quelques minutes.");
  });
});
