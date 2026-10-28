import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { EmailOutboxStatus, InvoiceDocumentType, InvoiceStatus, InvoiceType, QuoteStatus, SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

// Lot E-b (audit du 25/10/2026, P2 Stripe et e-mails) : chaque test reproduit un défaut relevé avant sa correction.
const { stripeMock } = vi.hoisted(() => ({
  stripeMock: {
    subscriptions: { retrieve: vi.fn(async (_id: string): Promise<unknown> => ({})), update: vi.fn(async () => ({})), cancel: vi.fn(async () => ({})) },
    paymentIntents: { search: vi.fn(async (_p: unknown): Promise<unknown> => ({ data: [] })), retrieve: vi.fn(async (id: string) => ({ id, latest_charge: null, payment_method: null })) },
  },
}));
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => stripeMock),
  getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_fake", webhookSecret: "whsec_test", mode: "test" as const, enabled: true })),
}));
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: async () => true,
}));

const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { approveReviewEmail, approveReviewEmails } = await import("@/lib/email/review.js");
const { finishBuyoutSignature } = await import("@/lib/subscriptions/buyout.js");
const { scheduleSubscriptionEnd } = await import("@/lib/subscriptions/subscription-service.js");
const { sendDueTermEndReminders } = await import("@/lib/subscriptions/renewal-reminder.js");
const { notifySubscriptionSync } = await import("@/lib/subscriptions/dunning.js");
const { issueErpInvoiceFromStripeInvoice } = await import("@/lib/stripe/billing.js");
const { processStripeEvent, recheckStuckPaymentProcessing } = await import("@/lib/stripe/webhook-handlers.js");
const { activateSubscriptionsFromDocument } = await import("@/lib/subscriptions/activate-from-document.js");
const { convertQuoteToInvoice } = await import("@/lib/invoices/transitions.js");

const DAY = 86_400_000;

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { email: "contact@kouzia.test", moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake") } });
  const { invalidateCompanySettingsCache } = await import("@/lib/company.js");
  invalidateCompanySettingsCache();
  stripeMock.subscriptions.retrieve.mockReset();
  stripeMock.paymentIntents.search.mockReset();
  stripeMock.paymentIntents.search.mockResolvedValue({ data: [] });
});

async function clientWithEmail() {
  const c = await createClient({ displayName: "Lou Martin", type: "B2C" });
  return prisma.client.update({ where: { id: c.id }, data: { firstName: "Lou", emailEncrypted: encrypt("lou@example.com") } });
}

async function subscription(extra: Record<string, unknown> = {}) {
  const client = await clientWithEmail();
  const service = await createService({ name: "Maintenance", isSubscription: true });
  return prisma.subscription.create({
    data: { clientId: client.id, serviceId: service.id, label: "Maintenance", amountCents: 3_000, billingDay: 1, billingInterval: "MONTH", startDate: new Date(Date.now() - 60 * DAY), nextInvoiceAt: new Date(Date.now() + 20 * DAY), ...extra },
  });
}

const reviewRow = (kind: string, documentId: string, clientId: string, family: "payment_issue" | "subscription_notice") =>
  mailEnqueue({ to: "lou@example.com", subject: "Objet", text: "Texte", clientId, kind, documentId }, { review: { family, origin: "WORKER" } });
const statusOf = async (id: string) => (await prisma.emailOutbox.findUniqueOrThrow({ where: { id } })).status;

describe("e-mails en attente devenus sans objet", () => {
  it("échec de paiement réglé depuis : la validation le retire au lieu de l'envoyer (unitaire et en lot)", async () => {
    const client = await clientWithEmail();
    const inv = await prisma.invoice.create({ data: { documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: "F-2026-0700", clientId: client.id, subtotalCents: 1, totalCents: 1 } });
    const one = await reviewRow("payment_failed", inv.id, client.id, "payment_issue");
    const two = await reviewRow("subscription_payment_failed", inv.id, client.id, "payment_issue");
    expect(await statusOf(one.outboxId)).toBe(EmailOutboxStatus.REVIEW);
    await prisma.invoice.update({ where: { id: inv.id }, data: { status: InvoiceStatus.PAID } });
    await expect(approveReviewEmail(one.outboxId)).rejects.toMatchObject({ status: 409 });
    expect(await statusOf(one.outboxId)).toBe(EmailOutboxStatus.REJECTED);
    expect(await approveReviewEmails([two.outboxId])).toBe(0);
    expect(await statusOf(two.outboxId)).toBe(EmailOutboxStatus.REJECTED);
  });

  it("rachat signé ou fin programmée : les avis d'abonnement en attente sont retirés ; les avis portent l'abonnement", async () => {
    const sub = await subscription({ commitmentMonths: 12, commitmentEndsAt: new Date(Date.now() + 40 * DAY) });
    expect(await sendDueTermEndReminders()).toBe(1);
    const notice = await prisma.emailOutbox.findFirstOrThrow({ where: { reviewKind: "subscription_term_end" } });
    expect(notice.documentId).toBe(sub.id);
    // Envoyé d'office (28/10/2026) : en file, pas encore parti, il est retiré comme un avis en attente de validation.
    expect(notice.status).toBe(EmailOutboxStatus.PENDING);
    await finishBuyoutSignature({ subscriptionId: sub.id, endDate: new Date(), stripe: null });
    expect(await statusOf(notice.id)).toBe(EmailOutboxStatus.REJECTED);

    const other = await subscription({ commitmentMonths: 12, commitmentEndsAt: new Date(Date.now() + 200 * DAY) });
    const renewal = await reviewRow("subscription_renewal", other.id, other.clientId, "subscription_notice");
    await scheduleSubscriptionEnd(other.id);
    expect(await statusOf(renewal.outboxId)).toBe(EmailOutboxStatus.REJECTED);
  });
});

describe("Stripe", () => {
  it("fin programmée depuis l'ERP (rachat) appliquée par Stripe : pas d'accusé de résiliation au client", async () => {
    const endDate = new Date(Date.now() + 30 * DAY);
    const sub = await subscription({ endDate });
    await notifySubscriptionSync({ subscriptionId: sub.id, change: null, becameUnpaid: false, cancelScheduledAt: new Date(endDate.getTime() + 1), cancelRevoked: false });
    expect(await prisma.emailOutbox.count({ where: { reviewKind: "subscription_cancel_scheduled" } })).toBe(0);
    // Résiliation faite par le client dans Stripe (autre date) : accusé envoyé, comme avant.
    const other = await subscription();
    await notifySubscriptionSync({ subscriptionId: other.id, change: null, becameUnpaid: false, cancelScheduledAt: new Date(Date.now() + 90 * DAY), cancelRevoked: false });
    expect(await prisma.emailOutbox.count({ where: { reviewKind: "subscription_cancel_scheduled" } })).toBe(1);
  });

  it("facture Stripe de prorata : le prix de l'abonnement ne change pas", async () => {
    const sub = await subscription({ collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_prorata" });
    const stripeInvoice = {
      id: "in_prorata", amount_due: 1_250, amount_paid: 0, billing_reason: "subscription_update",
      period_start: Math.floor(Date.now() / 1000), period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
      parent: { subscription_details: { subscription: "sub_prorata" } }, lines: { data: [] },
    } as unknown as Stripe.Invoice;
    await issueErpInvoiceFromStripeInvoice(stripeInvoice);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).amountCents).toBe(3_000);
  });

  it("événement « updated » ancien reçu après la résiliation : l'état actuel relu chez Stripe fait foi", async () => {
    const sub = await subscription({ collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_ordre" });
    stripeMock.subscriptions.retrieve.mockResolvedValue({ id: "sub_ordre", status: "canceled", ended_at: Math.floor(Date.now() / 1000), livemode: false, metadata: { erpSubscriptionId: sub.id }, items: { data: [] }, cancel_at: null, cancel_at_period_end: false, pause_collection: null });
    await processStripeEvent({
      id: "evt_ancien", type: "customer.subscription.updated", livemode: false,
      data: { object: { id: "sub_ordre", status: "active", livemode: false, metadata: { erpSubscriptionId: sub.id }, items: { data: [] }, cancel_at: null, cancel_at_period_end: false, pause_collection: null } },
    } as unknown as Stripe.Event);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(SubscriptionStatus.ENDED);
  });

  it("prélèvement « en cours » depuis plus de 7 jours : le worker relit le paiement réussi chez Stripe et l'enregistre", async () => {
    const client = await clientWithEmail();
    const inv = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: "F-2026-0701", clientId: client.id,
        subtotalCents: 9_000, totalCents: 9_000, issueDate: new Date(), paymentProcessingAt: new Date(Date.now() - 8 * DAY), paymentProcessingMethod: "sepa_debit",
      },
    });
    stripeMock.paymentIntents.search.mockResolvedValue({ data: [{ id: "pi_bloque", status: "succeeded", created: 1, amount: 9_000, amount_received: 9_000, metadata: { erpInvoiceId: inv.id }, payment_method_types: ["sepa_debit"] }] });
    expect(await recheckStuckPaymentProcessing()).toBe(1);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe(InvoiceStatus.PAID);
    expect(after.paymentProcessingAt).toBeNull();
  });
});

describe("avenant", () => {
  it("devis d'avenant signé mais pas encore facturé : l'échéance ne saute pas ; elle avance à la conversion en facture", async () => {
    const sub = await subscription();
    const service = await prisma.service.findUniqueOrThrow({ where: { id: sub.serviceId } });
    const quote = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.ACCEPTED, quoteDecidedAt: new Date(), number: "D-2026-0700",
        clientId: sub.clientId, subtotalCents: 13_500, totalCents: 13_500, issueDate: new Date(),
        lines: {
          create: [
            { position: 1, description: "Refonte", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 },
            { position: 2, description: "Maintenance révisée", quantity: 1, unitPriceCents: 3_500, lineTotalCents: 3_500, isSubscription: true, billingInterval: "MONTH", billingDay: 1, serviceId: service.id, revisesSubscriptionId: sub.id },
          ],
        },
      },
    });
    const before = sub.nextInvoiceAt;
    await prisma.$transaction((tx) => activateSubscriptionsFromDocument(quote.id, tx));
    const signed = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(signed.amountCents).toBe(3_500);
    expect(signed.nextInvoiceAt.getTime()).toBe(before.getTime());

    await convertQuoteToInvoice(quote.id);
    const converted = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(converted.nextInvoiceAt.getMonth()).toBe((before.getMonth() + 1) % 12);
  });
});
