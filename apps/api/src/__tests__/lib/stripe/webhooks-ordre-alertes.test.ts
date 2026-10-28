/**
 * Webhooks Stripe (audit du 28/10/2026, branche audit/abos) : route réelle (corps brut, signature), séquences d'événements
 * dans le désordre. Aucune clé réelle : secret et clé factices chiffrés dans les réglages de la base de test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import type { FastifyInstance } from "fastify";
import { InvoiceStatus, SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

const alertAdmin = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));
// Aucun appel réseau vers Stripe : relectures refusées (le code retombe sur l'objet de l'événement).
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<object>()),
  getStripe: async () => {
    throw new Error("réseau Stripe interdit en test");
  },
}));

const SECRET = "whsec_audit_factice";
const { buildApp } = await import("@/app.js");
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
    data: { stripeSecretKeyEncrypted: encrypt("sk_test_audit_factice_0000"), stripeWebhookSecretEncrypted: encrypt(SECRET), moduleStripeEnabled: true },
  });
  invalidateCompanySettingsCache();
  alertAdmin.mockClear();
});

function post(event: object, opts: { tamper?: boolean; noHeader?: boolean } = {}) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return app.inject({
    method: "POST",
    url: "/api/webhooks/stripe",
    headers: { "content-type": "application/json", ...(opts.noHeader ? {} : { "stripe-signature": header }) },
    payload: opts.tamper ? payload.replace("1000", "9000") : payload,
  });
}

const refund = (id: string) => ({ id, object: "event", type: "charge.refunded", livemode: false, created: 1_790_000_000, data: { object: { id: "ch_1", payment_intent: "pi_absent", amount_refunded: 1000 } } });

describe("route /api/webhooks/stripe", () => {
  it("signature valide : 200 ; rejouée : doublon ; altérée : 401 ; absente : 400", async () => {
    const ok = await post(refund("evt_a1"));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, duplicate: false });
    const again = await post(refund("evt_a1"));
    expect(again.json()).toMatchObject({ duplicate: true });
    expect(alertAdmin).toHaveBeenCalledTimes(1);
    expect((await post(refund("evt_a2"), { tamper: true })).statusCode).toBe(401);
    expect((await post(refund("evt_a3"), { noHeader: true })).statusCode).toBe(400);
  });

  it("événement live reçu avec une clé test : ignoré, rien de modifié", async () => {
    const res = await post({ ...refund("evt_live"), livemode: true });
    expect(res.json().handled).toMatch(/ignoré/);
    expect(alertAdmin).not.toHaveBeenCalled();
  });
});

async function erpSub() {
  const client = await createClient({ displayName: "Atelier Audit" });
  const service = await createService({ name: "Maintenance site", unitPriceCents: 35_000 });
  return prisma.subscription.create({
    data: {
      clientId: client.id, serviceId: service.id, label: "Maintenance site", amountCents: 35_000, billingDay: 1, billingInterval: "YEAR",
      startDate: new Date(), nextInvoiceAt: new Date(), status: SubscriptionStatus.ACTIVE, collectionMethod: SubscriptionCollectionMethod.STRIPE,
    },
  });
}

function stripeInvoice(erpId: string, extra: object = {}) {
  const start = Math.floor(Date.now() / 1000);
  return {
    id: "in_audit_1", object: "invoice", livemode: false, billing_reason: "subscription_create", total: 35_000, amount_due: 35_000, amount_paid: 35_000,
    status: "paid", status_transitions: { paid_at: start },
    parent: { subscription_details: { subscription: "sub_ooo", metadata: { erpSubscriptionId: erpId } } },
    lines: { data: [{ amount: 35_000, period: { start, end: start + 365 * 86_400 }, description: "Maintenance site" }] },
    ...extra,
  };
}

describe("séquence dans le désordre : invoice.paid avant checkout.session.completed et invoice.finalized", () => {
  it("une seule facture ERP, payée une fois, abonnement relié", async () => {
    const sub = await erpSub();
    const ev = (id: string, type: string, object: object) => ({ id, object: "event", type, livemode: false, created: 1_790_000_000, data: { object } });
    expect((await post(ev("evt_p", "invoice.paid", stripeInvoice(sub.id)))).statusCode).toBe(200);
    expect((await post(ev("evt_c", "checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: "sub_ooo", metadata: { erpSubscriptionId: sub.id } }))).statusCode).toBe(200);
    expect((await post(ev("evt_f", "invoice.finalized", stripeInvoice(sub.id, { status: "open" })))).statusCode).toBe(200);
    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: sub.id }, include: { payments: true } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe(InvoiceStatus.PAID);
    expect(invoices[0]!.payments.reduce((s, p) => s + p.amountCents, 0)).toBe(35_000);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).stripeSubscriptionId).toBe("sub_ooo");
  });

  it("échéance Stripe reçue pour un abonnement ERP clôturé (fin annulée dans Stripe) : alerte admin", async () => {
    const sub = await erpSub();
    await prisma.subscription.update({ where: { id: sub.id }, data: { stripeSubscriptionId: "sub_ooo", status: SubscriptionStatus.ENDED, endDate: new Date(Date.now() - 86_400_000) } });
    const res = await post({ id: "evt_e", object: "event", type: "invoice.finalized", livemode: false, created: 1_790_000_000, data: { object: stripeInvoice(sub.id, { status: "open", billing_reason: "subscription_cycle" }) } });
    expect(res.statusCode).toBe(200);
    // Le client est prélevé pour un contrat que l'ERP croit terminé : facture émise, et alerte.
    expect(alertAdmin).toHaveBeenCalled();
  });
});
