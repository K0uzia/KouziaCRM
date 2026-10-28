/**
 * Écarts relevés par l'essai Stripe réel en mode test du 28/10/2026 (branche audit/abos, scripts/audit-e2e), rejoués
 * ici avec un Stripe simulé : paiement d'abonnement sans PaymentIntent dans invoice.paid, litige reçu avant le paiement,
 * litige perdu, fin calée sur la période Stripe, 1re échéance expirée, impayé réglé alors que Stripe reste « unpaid ».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { InvoiceDocumentType, InvoiceStatus, PaymentMethod, SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/mailer/index.js", () => ({ mailEnqueue: vi.fn(async () => ({ outboxId: "o", messageId: "<x@y>" })) }));
vi.mock("@/lib/email/send-document-pdf.js", () => ({ sendDocumentPdf: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/payment-receipt.js", () => ({ sendPaymentReceipt: vi.fn(async () => undefined) }));
vi.mock("@/lib/email/smtp.js", () => ({ isSmtpConfigured: vi.fn(async () => true) }));
const alertAdmin = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));
const invoicesRetrieve = vi.fn(async (_id: string, _p?: unknown): Promise<unknown> => ({}));
const subsRetrieve = vi.fn(async (_id: string, _p?: unknown): Promise<unknown> => ({}));
const subsUpdate = vi.fn(async (_id: string, _p?: unknown): Promise<unknown> => ({}));
const piRetrieve = vi.fn(async (id: string, _p?: unknown): Promise<unknown> => ({ id, latest_charge: null }));
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => ({
    paymentIntents: { retrieve: piRetrieve },
    subscriptions: { retrieve: subsRetrieve, update: subsUpdate },
    invoices: { retrieve: invoicesRetrieve },
  })),
}));

const { processStripeEvent } = await import("@/lib/stripe/webhook-handlers.js");
const { issueErpInvoiceFromStripeInvoice, syncSubscriptionFromStripe } = await import("@/lib/stripe/billing.js");
const { notifySubscriptionSync } = await import("@/lib/subscriptions/dunning.js");
const { alignOnStripePeriod } = await import("@/lib/stripe/subscription-control.js");

const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { email: "admin@kouzia.test", moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake") } });
  invalidateCompanySettingsCache();
  for (const m of [invoicesRetrieve, subsRetrieve, subsUpdate, alertAdmin]) m.mockClear();
  invoicesRetrieve.mockResolvedValue({});
});
afterEach(async () => {
  await resetDb();
});

async function stripeSub(extra: Record<string, unknown> = {}) {
  const c = await createClient({ displayName: "Atelier Essai" });
  await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt("atelier@exemple.test") } });
  const s = await createService();
  return prisma.subscription.create({
    data: {
      clientId: c.id, serviceId: s.id, label: "Site tout compris", amountCents: 4_900, billingDay: 1, billingInterval: "MONTH",
      startDate: new Date(), nextInvoiceAt: new Date(), collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_essai", stripeLivemode: false,
      ...extra,
    },
  });
}

function invoice(erpId: string, patch: Record<string, unknown> = {}) {
  const start = now();
  return {
    id: "in_essai", object: "invoice", livemode: false, billing_reason: "subscription_cycle", total: 4_900, amount_due: 4_900, amount_paid: 4_900,
    status: "paid", status_transitions: { paid_at: start },
    parent: { subscription_details: { subscription: "sub_essai", metadata: { erpSubscriptionId: erpId } } },
    lines: { data: [{ amount: 4_900, period: { start, end: start + 30 * 86_400 }, description: "Site" }] },
    ...patch,
  } as unknown as Stripe.Invoice;
}
const ev = (id: string, type: string, object: unknown, created = now()) => ({ id, object: "event", type, livemode: false, created, data: { object } }) as unknown as Stripe.Event;

describe("invoice.paid sans `payments` (API 2026-06-24)", () => {
  it("la facture est relue avec ses paiements : PaymentIntent, carte et frais enregistrés", async () => {
    const sub = await stripeSub();
    invoicesRetrieve.mockResolvedValue({ payments: { data: [{ payment: { payment_intent: "pi_carte" } }] } });
    piRetrieve.mockResolvedValueOnce({ id: "pi_carte", latest_charge: { payment_method_details: { type: "card" }, balance_transaction: { fee: 37 } } });
    await processStripeEvent(ev("evt_paid", "invoice.paid", invoice(sub.id)));
    expect(invoicesRetrieve).toHaveBeenCalledWith("in_essai", { expand: ["payments"] });
    const payment = await prisma.payment.findFirstOrThrow();
    expect(payment).toMatchObject({ stripePaymentIntentId: "pi_carte", method: PaymentMethod.CARD, feeCents: 37 });
  });
});

describe("litige et remboursement reçus avant le paiement", () => {
  it("litige reçu avant le paiement : erreur (Stripe renverra), puis enregistré au renvoi ; litige perdu : alerte", async () => {
    const sub = await stripeSub();
    const dispute = { id: "dp_1", object: "dispute", payment_intent: "pi_litige", amount: 4_900, reason: "fraudulent", status: "needs_response" };
    await expect(processStripeEvent(ev("evt_dispute", "charge.dispute.created", dispute))).rejects.toThrow(/pas encore enregistré/);
    // Réservation libérée : le renvoi de Stripe est traité.
    invoicesRetrieve.mockResolvedValue({ payments: { data: [{ payment: { payment_intent: "pi_litige" } }] } });
    await processStripeEvent(ev("evt_paid2", "invoice.paid", invoice(sub.id)));
    expect((await processStripeEvent(ev("evt_dispute", "charge.dispute.created", dispute))).duplicate).toBe(false);
    expect((await prisma.payment.findFirstOrThrow()).disputedCents).toBe(4_900);
    alertAdmin.mockClear();
    await processStripeEvent(ev("evt_lost", "charge.dispute.closed", { ...dispute, status: "lost" }));
    expect(alertAdmin.mock.calls.map((c) => String(c[0]))).toContain("Litige Stripe perdu");
    expect(String(alertAdmin.mock.calls.find((c) => c[0] === "Litige Stripe perdu")![1])).toContain("créez un avoir");
  });

  it("remboursement d'un paiement jamais passé par l'ERP (événement de plus de 3 jours) : traité, alerte « créez un avoir »", async () => {
    const res = await processStripeEvent(ev("evt_ref", "charge.refunded", { id: "ch_x", payment_intent: "pi_inconnu", amount_refunded: 1_000 }, now() - 5 * 86_400));
    expect(res.duplicate).toBe(false);
    expect(String(alertAdmin.mock.calls[0]![1])).toContain("Créez un avoir");
  });
});

describe("fin calée sur la période Stripe et libellé de période", () => {
  it("fin du terme à l'heure de Paris, 1 h avant la fin de période Stripe : calée sur celle-ci", () => {
    const stripeEnd = Date.UTC(2027, 9, 28, 9, 0, 0) / 1000; // 28/10/2027 9 h UTC
    const parisEnd = new Date(Date.UTC(2027, 9, 28, 8, 0, 0));
    expect(alignOnStripePeriod(parisEnd, stripeEnd).getTime()).toBe(stripeEnd * 1000);
    // Écart d'un mois : jamais déplacée.
    expect(alignOnStripePeriod(parisEnd, stripeEnd + 30 * 86_400).getTime()).toBe(Date.UTC(2027, 9, 28, 9, 0, 0));
    expect(alignOnStripePeriod(parisEnd, null)).toEqual(parisEnd);
  });

  it("facture avec ligne de prorata en tête : la période vient de la ligne principale", async () => {
    const sub = await stripeSub();
    const start = Date.UTC(2027, 9, 28, 9) / 1000;
    const inv = invoice(sub.id, {
      status: "open", total: 4_900, amount_paid: 0,
      lines: {
        data: [
          { amount: 10, period: { start: start - 3600, end: start }, description: "Prorata", parent: { subscription_item_details: { proration: true } } },
          { amount: -10, period: { start: start - 3600, end: start }, description: "Prorata", parent: { subscription_item_details: { proration: true } } },
          { amount: 4_900, period: { start, end: start + 31 * 86_400 }, description: "Site" },
        ],
      },
    });
    const { invoiceId } = await issueErpInvoiceFromStripeInvoice(inv);
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { position: "asc" } });
    expect(lines.find((l) => l.description.startsWith("Site tout compris"))!.description).toMatch(/\(28\/10\/2027 - 28\/11\/2027\)/);
  });
});

describe("1re échéance jamais réglée, abonnement Stripe expiré", () => {
  it("la facture ERP de 1re échéance est annulée par un avoir automatique, l'administrateur est alerté", async () => {
    const sub = await stripeSub({ stripeStatus: "incomplete" });
    const { invoiceId } = await issueErpInvoiceFromStripeInvoice(invoice(sub.id, { status: "open", amount_paid: 0, billing_reason: "subscription_create" }));
    const result = await syncSubscriptionFromStripe({
      id: "sub_essai", object: "subscription", status: "incomplete_expired", livemode: false, cancel_at: null, cancel_at_period_end: false,
      pause_collection: null, metadata: { erpSubscriptionId: sub.id }, items: { data: [{ price: { unit_amount: 4_900, recurring: { interval: "month", interval_count: 1 } } }] },
    } as unknown as Stripe.Subscription);
    expect(result?.firstChargeExpired).toBe(true);
    await notifySubscriptionSync(result!);
    const credit = await prisma.invoice.findFirstOrThrow({ where: { documentType: InvoiceDocumentType.CREDIT_NOTE, creditedInvoiceId: invoiceId } });
    expect(credit.totalCents).toBe(-4_900);
    expect(alertAdmin.mock.calls.some((c) => String(c[0]).startsWith("1re échéance non réglée"))).toBe(true);
  });
});

describe("impayé réglé après la suspension", () => {
  it("Stripe redevenu actif : l'ERP reprend l'abonnement", async () => {
    const sub = await stripeSub({ status: SubscriptionStatus.PAUSED, stripeStatus: "unpaid" });
    subsRetrieve.mockResolvedValue({
      id: "sub_essai", status: "active", livemode: false, cancel_at: null, cancel_at_period_end: false, pause_collection: null,
      metadata: { erpSubscriptionId: sub.id }, items: { data: [{ price: { unit_amount: 4_900, recurring: { interval: "month", interval_count: 1 } } }] },
    });
    await processStripeEvent(ev("evt_paid3", "invoice.paid", invoice(sub.id)));
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(SubscriptionStatus.ACTIVE);
  });

  it("Stripe encore « unpaid » : alerte claire, l'ERP reste suspendu", async () => {
    const sub = await stripeSub({ status: SubscriptionStatus.PAUSED, stripeStatus: "unpaid" });
    subsRetrieve.mockResolvedValue({ id: "sub_essai", status: "unpaid", metadata: { erpSubscriptionId: sub.id }, items: { data: [] } });
    await processStripeEvent(ev("evt_paid4", "invoice.paid", invoice(sub.id)));
    const erp = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(erp.status).toBe(InvoiceStatus.PAID);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(SubscriptionStatus.PAUSED);
    const alert = alertAdmin.mock.calls.find((c) => String(c[0]).startsWith("Impayé réglé, abonnement encore suspendu"));
    expect(String(alert?.[1])).toContain("finalisez et faites régler la dernière facture");
  });
});
