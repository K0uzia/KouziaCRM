import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Remise d'un abonnement prélevé par Stripe (R2) : coupon à la mise en place, factures remisées comptées par l'ERP,
// remise retirée de l'abonnement Stripe après la dernière échéance remisée.
const stripeMock = {
  coupons: { retrieve: vi.fn(), create: vi.fn() },
  checkout: { sessions: { create: vi.fn(async () => ({ url: "https://checkout.stripe.com/c/pay/cs_test_remise" })) } },
  subscriptions: { deleteDiscount: vi.fn(async () => ({ deleted: true })) },
};
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => stripeMock),
  getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_fake", webhookSecret: "whsec", mode: "test" as const, enabled: true })),
}));
vi.mock("@/lib/email/smtp.js", async (orig) => ({ ...(await orig<typeof import("@/lib/email/smtp.js")>()), isSmtpConfigured: async () => false }));
const alertAdmin = vi.fn(async () => undefined);
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));

const { couponParams } = await import("@/lib/stripe/subscription-discount.js");
const { nextPeriodAmountCents } = await import("@/lib/quotes/recurring-discount-calc.js");
const { createSubscriptionCheckoutSession } = await import("@/lib/stripe/checkout.js");
const { issueErpInvoiceFromStripeInvoice } = await import("@/lib/stripe/billing.js");

const DAY = 86_400_000;
const base = { id: "sub1", discountKind: "PERCENT", discountValue: 3000, discountPeriods: 1, discountPeriodsBilled: 0, billingInterval: "YEAR", nextInvoiceAt: new Date() };

describe("montant de la prochaine échéance (avis de 1re échéance)", () => {
  it("remise déduite tant qu'il reste des échéances remisées", () => {
    const sub = { amountCents: 150000, discountKind: "PERCENT", discountValue: 3000, discountPeriods: 1, discountPeriodsBilled: 0 };
    expect(nextPeriodAmountCents(sub)).toBe(105000);
    expect(nextPeriodAmountCents({ ...sub, discountPeriodsBilled: 1 })).toBe(150000);
    expect(nextPeriodAmountCents({ ...sub, discountKind: null, discountValue: null, discountPeriods: null })).toBe(150000);
  });
});

describe("coupon Stripe de la remise", () => {
  it("durée large mais jamais forever ; identifiant qui décrit la remise", () => {
    const now = new Date(2026, 9, 26);
    expect(couponParams({ ...base, nextInvoiceAt: now }, now)).toMatchObject({ id: "kouzia-sub1-1x-p3000", duration: "repeating", duration_in_months: 12, percent_off: 30 });
    // Trimestriel, 4 échéances, 1re dans 75 jours : 3 mois d'attente + 12 mois.
    expect(couponParams({ ...base, billingInterval: "QUARTER", discountPeriods: 4, nextInvoiceAt: new Date(now.getTime() + 75 * DAY) }, now)).toMatchObject({ duration_in_months: 15 });
    expect(couponParams({ ...base, discountKind: "FIXED", discountValue: 20000, discountPeriods: 2, discountPeriodsBilled: 1, nextInvoiceAt: now }, now)).toMatchObject({
      id: "kouzia-sub1-1x-f20000",
      amount_off: 20000,
      currency: "eur",
    });
    expect(couponParams({ ...base, discountPeriodsBilled: 1 }, now)).toBeNull();
    expect(couponParams({ ...base, discountKind: null }, now)).toBeNull();
  });
});

describe("abonnement remisé prélevé par Stripe", () => {
  beforeEach(async () => {
    await resetDb();
    await seedCompanySettings();
    await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake") } });
    invalidateCompanySettingsCache();
    for (const m of [stripeMock.coupons.retrieve, stripeMock.coupons.create, stripeMock.checkout.sessions.create, stripeMock.subscriptions.deleteDiscount, alertAdmin]) m.mockClear();
  });

  async function subscription(extra: Record<string, unknown> = {}) {
    const client = await createClient({ displayName: "Atelier Stripe" });
    await prisma.client.update({ where: { id: client.id }, data: { stripeCustomerId: "cus_test", stripeCustomerLivemode: false } });
    const service = await prisma.service.create({ data: { name: "Site", unitPriceCents: 150000, unit: "FORFAIT", active: true, isSubscription: true, billingInterval: "YEAR" } });
    return prisma.subscription.create({
      data: {
        clientId: client.id, serviceId: service.id, label: "Site tout compris", amountCents: 150000, billingDay: 1, billingInterval: "YEAR",
        startDate: new Date(), nextInvoiceAt: new Date(), status: SubscriptionStatus.ACTIVE,
        discountKind: "PERCENT", discountValue: 3000, discountPeriods: 1, ...extra,
      },
    });
  }

  it("mise en place : coupon créé s'il manque, puis réutilisé, et passé à la session", async () => {
    const sub = await subscription();
    stripeMock.coupons.retrieve.mockRejectedValueOnce(Object.assign(new Error("No such coupon"), { code: "resource_missing" }));
    stripeMock.coupons.create.mockImplementationOnce(async (p: { id: string }) => ({ id: p.id }));
    await createSubscriptionCheckoutSession(sub.id);
    const id = `kouzia-${sub.id}-1x-p3000`;
    expect(stripeMock.coupons.create).toHaveBeenCalledWith(expect.objectContaining({ id, duration: "repeating", percent_off: 30 }));
    expect((stripeMock.checkout.sessions.create.mock.calls[0] as unknown[])[0]).toMatchObject({ mode: "subscription", discounts: [{ coupon: id }] });

    stripeMock.coupons.retrieve.mockResolvedValueOnce({ id });
    await createSubscriptionCheckoutSession(sub.id);
    expect(stripeMock.coupons.create).toHaveBeenCalledTimes(1);
  });

  it("sans remise : ni coupon ni discounts", async () => {
    const sub = await subscription({ discountKind: null, discountValue: null, discountPeriods: null });
    await createSubscriptionCheckoutSession(sub.id);
    expect(stripeMock.coupons.retrieve).not.toHaveBeenCalled();
    expect((stripeMock.checkout.sessions.create.mock.calls[0] as unknown[])[0]).not.toHaveProperty("discounts");
  });

  const stripeInvoice = (id: string, stripeSubId: string, discount: number) =>
    ({
      id,
      amount_due: 150000 - discount,
      amount_paid: 0,
      total_discount_amounts: discount ? [{ amount: discount, discount: "di_1" }] : [],
      period_start: Math.floor(Date.now() / 1000),
      period_end: Math.floor(Date.now() / 1000) + 365 * 86400,
      parent: { subscription_details: { subscription: stripeSubId } },
      customer_email: null,
      lines: { data: [] },
    }) as unknown as Stripe.Invoice;

  it("facture remisée : tarif plein et ligne de remise, échéance comptée, remise retirée dans Stripe ; la suivante au tarif plein", async () => {
    const sub = await subscription({ collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_stripe_remise" });
    const first = await issueErpInvoiceFromStripeInvoice(stripeInvoice("in_1", "sub_stripe_remise", 45000));
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: first.invoiceId }, include: { lines: { orderBy: { position: "asc" } } } });
    expect(inv.totalCents).toBe(105000);
    expect(inv.lines.map((l) => [l.description.startsWith("Remise") ? l.description : "abonnement", l.lineTotalCents])).toEqual([
      ["abonnement", 150000],
      ["Remise (échéance 1 sur 1)", -45000],
    ]);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).discountPeriodsBilled).toBe(1);
    expect(stripeMock.subscriptions.deleteDiscount).toHaveBeenCalledWith("sub_stripe_remise");
    // Même facture rejouée : rien n'est compté deux fois.
    await issueErpInvoiceFromStripeInvoice(stripeInvoice("in_1", "sub_stripe_remise", 45000));
    expect(stripeMock.subscriptions.deleteDiscount).toHaveBeenCalledTimes(1);

    const second = await issueErpInvoiceFromStripeInvoice(stripeInvoice("in_2", "sub_stripe_remise", 0));
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: second.invoiceId }, include: { lines: true } })).lines).toHaveLength(1);
  });

  it("retrait impossible dans Stripe : l'admin est alerté", async () => {
    await subscription({ collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_stripe_erreur" });
    stripeMock.subscriptions.deleteDiscount.mockRejectedValueOnce(new Error("Stripe indisponible"));
    await issueErpInvoiceFromStripeInvoice(stripeInvoice("in_3", "sub_stripe_erreur", 45000));
    expect(alertAdmin).toHaveBeenCalledWith(expect.stringContaining("Remise d'abonnement à retirer dans Stripe"), expect.stringContaining("sub_stripe_erreur"));
  });
});
