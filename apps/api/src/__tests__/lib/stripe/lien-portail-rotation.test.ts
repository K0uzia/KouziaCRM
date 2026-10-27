import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { subscriptionIdFromShortToken, subscriptionPaymentUrl } from "@/lib/stripe/portal.js";
import { closeEndedSubscriptions } from "@/lib/subscriptions/subscription-service.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

// P2 de l'audit du 27/10/2026 (décision 12) : lien court vers le portail Stripe (Subscription.publicToken) sans fin ni
// renouvellement. Désormais : refusé une fois l'abonnement clôturé (jeton retiré), renouvelé quand l'administrateur
// déconnecte les appareils du client (accès compromis).
const { buildApp } = await import("@/app.js");
const ADMIN = "admin-lien-portail@kouzia.test";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

async function stripeSubscription() {
  const client = await createClient({ displayName: "Client Portail Stripe" });
  const service = await createService();
  const sub = await prisma.subscription.create({
    data: { clientId: client.id, serviceId: service.id, label: "Maintenance", amountCents: 3000, billingDay: 1, startDate: new Date(), nextInvoiceAt: new Date(), stripeSubscriptionId: `sub_${Math.random()}`, status: SubscriptionStatus.ACTIVE },
  });
  const url = await subscriptionPaymentUrl(sub);
  return { client, sub, token: url.split("/").pop()! };
}

describe("lien court du portail Stripe", () => {
  it("abonnement clôturé : jeton retiré, lien refusé", async () => {
    const { sub, token } = await stripeSubscription();
    expect(await subscriptionIdFromShortToken(token)).toBe(sub.id);
    await prisma.subscription.update({ where: { id: sub.id }, data: { endDate: new Date(Date.now() - 1000) } });
    await closeEndedSubscriptions();
    expect(await subscriptionIdFromShortToken(token)).toBeNull();
  });

  it("« Déconnecter tous ses appareils » : nouveau jeton, l'ancien lien ne sert plus", async () => {
    const { client, sub, token } = await stripeSubscription();
    const res = await app.inject({ method: "POST", url: `/api/clients/${client.id}/portal/revoke-sessions`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(await subscriptionIdFromShortToken(token)).toBeNull();
    const fresh = (await subscriptionPaymentUrl(sub)).split("/").pop()!;
    expect(fresh).not.toBe(token);
    expect(await subscriptionIdFromShortToken(fresh)).toBe(sub.id);
  });
});
