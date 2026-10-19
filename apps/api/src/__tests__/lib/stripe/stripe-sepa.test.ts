import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { processStripeEvent } from "@/lib/stripe/webhook-handlers.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", () => ({
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: vi.fn(async () => false),
}));

const mockStripe = {
  subscriptions: {
    retrieve: vi.fn(async (_id: string, _opts?: unknown) => ({
      id: "sub_1",
      default_payment_method: { id: "pm_1", type: "sepa_debit", sepa_debit: { last4: "3000" } },
    })),
  },
  paymentIntents: { retrieve: vi.fn(async (id: string) => ({ id, latest_charge: null })) },
};
vi.mock("@/lib/stripe/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stripe/client.js")>();
  return {
    ...actual,
    getStripe: vi.fn(async () => mockStripe),
    getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_fake", webhookSecret: "whsec_test", mode: "test" as const, enabled: true })),
  };
});

const ADMIN = "admin@kouzia.test";
const EMAIL = "lou@exemple.fr";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: { moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake"), email: ADMIN, bankIban: "FR7630006000011234567890189" },
  });
  invalidateCompanySettingsCache();
});
afterEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

async function issuedInvoice() {
  const client = await createClient({ displayName: "Lou Martin" });
  await prisma.client.update({ where: { id: client.id }, data: { firstName: "Lou", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
  return prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      number: "F-2026-0101",
      issueDate: new Date(),
      subtotalCents: 150_000,
      totalCents: 150_000,
      checkoutUrl: "https://api.kouzia.test/api/public/pay/jeton",
      lines: { create: [{ position: 1, description: "Site", quantity: 1, unitPriceCents: 150_000, lineTotalCents: 150_000 }] },
    },
  });
}

async function dueMilestone() {
  const client = await createClient({ displayName: "Lou Martin" });
  await prisma.client.update({ where: { id: client.id }, data: { firstName: "Lou", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
  const quote = await prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType: InvoiceDocumentType.QUOTE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      quoteStatus: "ACCEPTED",
      number: "D-2026-0101",
      issueDate: new Date(),
      subtotalCents: 100_000,
      totalCents: 100_000,
    },
  });
  return prisma.paymentMilestone.create({
    data: {
      quoteId: quote.id,
      position: 1,
      label: "Acompte",
      percentBps: 3000,
      amountCents: 30_000,
      triggerText: "À la signature",
      status: "DUE",
      checkoutUrl: "https://api.kouzia.test/api/public/pay/acompte",
    },
  });
}

let n = 0;
const event = (type: string, object: unknown) => ({ id: `evt_sepa_${++n}`, type, livemode: false, data: { object } }) as unknown as Stripe.Event;
const intent = (invoiceId: string, extra: Record<string, unknown> = {}) => ({
  id: `pi_${n}`,
  amount: 150_000,
  amount_received: 150_000,
  payment_method_types: ["sepa_debit", "customer_balance"],
  payment_method: null,
  metadata: { erpInvoiceId: invoiceId },
  ...extra,
});

async function outbox() {
  return (await prisma.emailOutbox.findMany()).map((r) => parsePayload(outboxPayloadRaw(r)));
}

describe("prélèvement SEPA : en cours, échec, mandat, moyen d'un abonnement", () => {
  it("payment_intent.processing : la facture est « en cours » (SEPA) ; réussite : effacé et payée", async () => {
    const inv = await issuedInvoice();
    await processStripeEvent(event("payment_intent.processing", intent(inv.id)));
    const during = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(during.paymentProcessingAt).not.toBeNull();
    expect(during.paymentProcessingMethod).toBe("sepa_debit");

    await processStripeEvent(event("payment_intent.succeeded", intent(inv.id, { id: "pi_ok" })));
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe("PAID");
    expect(after.paymentProcessingAt).toBeNull();
  });

  it("payment_intent.payment_failed d'une facture : reste à régler, admin et client prévenus (lien et IBAN)", async () => {
    const inv = await issuedInvoice();
    await processStripeEvent(event("payment_intent.processing", intent(inv.id)));
    await processStripeEvent(
      event("payment_intent.payment_failed", intent(inv.id, { last_payment_error: { code: "insufficient_funds", message: "Fonds insuffisants" } })),
    );
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after).toMatchObject({ status: "ISSUED", paymentProcessingAt: null, paymentProcessingMethod: null });
    const mails = await outbox();
    const admin = mails.find((m) => m.to === ADMIN)!;
    expect(admin.subject).toBe("Prélèvement SEPA refusé : Lou Martin");
    expect(admin.text).toContain("Fonds insuffisants");
    const client = mails.find((m) => m.to === EMAIL)!;
    expect(client.subject).toBe("Paiement non abouti : F-2026-0101");
    expect(client.text).toContain("https://api.kouzia.test/api/public/pay/jeton");
    expect(client.text).toContain("FR7630006000011234567890189");
  });

  it("échéance de devis sans facture : « en cours » pendant le prélèvement, puis refus : échec, admin et client prévenus", async () => {
    const ms = await dueMilestone();
    const pi = (extra: Record<string, unknown> = {}) => ({ ...intent("", extra), amount: 30_000, metadata: { erpMilestoneId: ms.id } });
    await processStripeEvent(event("payment_intent.processing", pi()));
    expect(await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: ms.id } })).toMatchObject({ paymentProcessingMethod: "sepa_debit" });
    expect((await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: ms.id } })).paymentProcessingAt).not.toBeNull();

    await processStripeEvent(event("payment_intent.payment_failed", pi({ last_payment_error: { message: "Fonds insuffisants" } })));
    expect(await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: ms.id } })).toMatchObject({
      status: "FAILED",
      paymentProcessingAt: null,
      paymentProcessingMethod: null,
    });
    const mails = await outbox();
    expect(mails.some((m) => m.to === ADMIN)).toBe(true);
    const client = mails.find((m) => m.to === EMAIL)!;
    expect(client.subject).toBe("Paiement non abouti : devis D-2026-0101");
    expect(client.text).toContain("https://api.kouzia.test/api/public/pay/acompte");
    expect(client.text).toContain("FR7630006000011234567890189");
  });

  it("échéance : carte refusée pendant le paiement (jamais en cours) : pas d'e-mail au client ; réussite : en cours effacé", async () => {
    const ms = await dueMilestone();
    const pi = (extra: Record<string, unknown> = {}) => ({ ...intent("", extra), amount: 30_000, metadata: { erpMilestoneId: ms.id } });
    await processStripeEvent(event("payment_intent.payment_failed", pi({ last_payment_error: { message: "Carte refusée" } })));
    expect((await outbox()).some((m) => m.to === EMAIL)).toBe(false);

    await processStripeEvent(event("payment_intent.processing", pi()));
    await processStripeEvent(event("payment_intent.succeeded", pi({ id: "pi_acompte_ok", amount_received: 30_000 })));
    const after = await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: ms.id } });
    expect(after.status).toBe("PAID");
    expect(after.paymentProcessingAt).toBeNull();
  });

  it("mandate.updated inactif : alerte admin ; actif : rien", async () => {
    await processStripeEvent(event("mandate.updated", { id: "mandate_1", status: "active" }));
    expect(await outbox()).toHaveLength(0);
    await processStripeEvent(event("mandate.updated", { id: "mandate_2", status: "inactive" }));
    expect((await outbox()).map((m) => m.subject)).toEqual(["Mandat de prélèvement SEPA révoqué"]);
  });

  it("checkout.session.completed d'un abonnement : moyen enregistré (type et 4 derniers chiffres), jamais l'IBAN", async () => {
    const client = await createClient({ displayName: "Lou Martin" });
    const service = await createService({ name: "Site vitrine tout compris", unitPriceCents: 150_000 });
    const sub = await prisma.subscription.create({
      data: { clientId: client.id, serviceId: service.id, label: "Site", amountCents: 150_000, billingDay: 1, billingInterval: "YEAR", startDate: new Date(), nextInvoiceAt: new Date() },
    });
    await processStripeEvent(
      event("checkout.session.completed", { id: "cs_1", mode: "subscription", subscription: "sub_1", metadata: { erpSubscriptionId: sub.id } }),
    );
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({
      stripeSubscriptionId: "sub_1",
      paymentMethodType: "sepa_debit",
      paymentMethodLast4: "3000",
    });
    expect(mockStripe.subscriptions.retrieve).toHaveBeenCalledWith("sub_1", { expand: ["default_payment_method"] });
  });
});
