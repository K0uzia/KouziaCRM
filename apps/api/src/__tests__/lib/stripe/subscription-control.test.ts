import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

const cancel = vi.fn(async (_id: string): Promise<unknown> => ({}));
const update = vi.fn(async (_id: string, _params: unknown): Promise<unknown> => ({}));
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => ({ subscriptions: { cancel, update } })),
}));

const { endSubscription, pauseSubscription, resumeSubscription } = await import(
  "@/lib/subscriptions/subscription-service.js"
);
const { StripeSubscriptionSyncError } = await import("@/lib/stripe/subscription-control.js");
const { syncSubscriptionFromStripe } = await import("@/lib/stripe/billing.js");
const { listNotifications } = await import("@/lib/notifications/feed.js");
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-abonnements@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
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
  cancel.mockReset().mockResolvedValue({});
  update.mockReset().mockResolvedValue({});
});

async function stripeSub(status: SubscriptionStatus = SubscriptionStatus.ACTIVE) {
  const c = await createClient({ displayName: "Lou Martin" });
  const s = await createService();
  return prisma.subscription.create({
    data: {
      clientId: c.id,
      serviceId: s.id,
      label: "Maintenance",
      amountCents: 2_900,
      billingDay: 1,
      startDate: new Date(2026, 0, 1),
      nextInvoiceAt: new Date(2026, 11, 1),
      status,
      collectionMethod: SubscriptionCollectionMethod.STRIPE,
      stripeSubscriptionId: "sub_123",
    },
  });
}

function stripeEvent(sub: { id: string }, patch: Partial<Stripe.Subscription>): Stripe.Subscription {
  return {
    id: "sub_123",
    status: "active",
    pause_collection: null,
    metadata: { erpSubscriptionId: sub.id },
    items: { data: [{ price: { unit_amount: 2_900, recurring: { interval: "month" } } }] },
    ...patch,
  } as unknown as Stripe.Subscription;
}

describe("ERP vers Stripe : clôturer, suspendre, reprendre", () => {
  it("clôturer résilie d'abord le prélèvement Stripe", async () => {
    const sub = await stripeSub();
    const ended = await endSubscription(sub.id);
    expect(cancel).toHaveBeenCalledWith("sub_123");
    expect(ended.status).toBe(SubscriptionStatus.ENDED);
  });

  it("Stripe en échec : erreur claire, l'abonnement ne change pas", async () => {
    const sub = await stripeSub();
    cancel.mockRejectedValueOnce(new Error("Your card was declined"));
    await expect(endSubscription(sub.id)).rejects.toBeInstanceOf(StripeSubscriptionSyncError);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe(SubscriptionStatus.ACTIVE);
  });

  it("abonnement déjà absent de Stripe : la clôture se fait", async () => {
    const sub = await stripeSub();
    cancel.mockRejectedValueOnce(Object.assign(new Error("No such subscription"), { code: "resource_missing" }));
    expect((await endSubscription(sub.id)).status).toBe(SubscriptionStatus.ENDED);
  });

  it("suspendre puis reprendre passent par pause_collection", async () => {
    const sub = await stripeSub();
    expect((await pauseSubscription(sub.id)).status).toBe(SubscriptionStatus.PAUSED);
    expect(update).toHaveBeenLastCalledWith("sub_123", { pause_collection: { behavior: "void" } });
    expect((await resumeSubscription(sub.id)).status).toBe(SubscriptionStatus.ACTIVE);
    expect(update).toHaveBeenLastCalledWith("sub_123", { pause_collection: "" });
  });

  it("suspension refusée par Stripe : reste actif", async () => {
    const sub = await stripeSub();
    update.mockRejectedValueOnce(new Error("timeout"));
    await expect(pauseSubscription(sub.id)).rejects.toBeInstanceOf(StripeSubscriptionSyncError);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(
      SubscriptionStatus.ACTIVE,
    );
  });

  it("abonnement sans Stripe : aucun appel", async () => {
    const sub = await stripeSub();
    await prisma.subscription.update({ where: { id: sub.id }, data: { stripeSubscriptionId: null } });
    await endSubscription(sub.id);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("route : 502 et message, état inchangé", async () => {
    const sub = await stripeSub();
    await prisma.user.deleteMany({ where: { email: ADMIN } });
    await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
    const cookie = `${SESSION_COOKIE}=${login.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
    cancel.mockRejectedValueOnce(new Error("API indisponible"));
    const res = await app.inject({ method: "POST", url: `/api/subscriptions/${sub.id}/end`, headers: { cookie } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("l'abonnement n'est pas clôturé");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(
      SubscriptionStatus.ACTIVE,
    );
  });
});

describe("Stripe vers ERP : résiliation, impayés, pause", () => {
  it("résiliation dans Stripe : Clôturé, changement noté et notifié", async () => {
    const sub = await stripeSub();
    const since = new Date(Date.now() - 1000);
    const change = await syncSubscriptionFromStripe(stripeEvent(sub, { status: "canceled", ended_at: 1_800_000_000 }));
    expect(change).toMatchObject({ to: SubscriptionStatus.ENDED, reason: "résiliation faite dans Stripe", clientName: "Lou Martin" });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after).toMatchObject({ status: SubscriptionStatus.ENDED, stripeStatusChange: "ENDED" });
    const feed = await listNotifications(since);
    expect(feed.find((n) => n.kind === "subscription_stripe")?.title).toBe("Abonnement clôturé depuis Stripe");
  });

  it("impayés après relances : Clôturé avec le bon motif", async () => {
    const sub = await stripeSub();
    const change = await syncSubscriptionFromStripe(stripeEvent(sub, { status: "unpaid" }));
    expect(change?.reason).toBe("prélèvements impayés après les relances Stripe");
  });

  it("pause dans Stripe (statut active + pause_collection) : Suspendu", async () => {
    const sub = await stripeSub();
    const change = await syncSubscriptionFromStripe(
      stripeEvent(sub, { pause_collection: { behavior: "void" } as Stripe.Subscription.PauseCollection }),
    );
    expect(change?.to).toBe(SubscriptionStatus.PAUSED);
  });

  it("action lancée depuis l'ERP : le webhook qui suit ne notifie pas", async () => {
    const sub = await stripeSub(SubscriptionStatus.ENDED);
    expect(await syncSubscriptionFromStripe(stripeEvent(sub, { status: "canceled" }))).toBeNull();
  });

  it("un abonnement clôturé n'est pas rouvert par un événement Stripe tardif", async () => {
    const sub = await stripeSub(SubscriptionStatus.ENDED);
    await syncSubscriptionFromStripe(stripeEvent(sub, { status: "active" }));
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(
      SubscriptionStatus.ENDED,
    );
  });
});
