import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

// Devis à 2 propositions signé avec Stripe actif (P3, demande du 25/10/2026) : B (abonnement) donne la mise en place du
// prélèvement de B seule, remise de B comprise ; A (paiement unique) donne la session Checkout du 1er jalon de A.
const stripeMock = {
  coupons: { retrieve: vi.fn(), create: vi.fn() },
  checkout: { sessions: { create: vi.fn(async () => ({ id: "cs_test", url: "https://checkout.stripe.com/c/pay/cs_test_propositions" })) } },
  customers: { create: vi.fn(async () => ({ id: "cus_test" })), retrieve: vi.fn(async () => ({ id: "cus_test", deleted: false })), update: vi.fn(async () => ({ id: "cus_test" })) },
  subscriptions: { deleteDiscount: vi.fn() },
};
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => stripeMock),
}));
vi.mock("@/lib/email/smtp.js", async (orig) => ({ ...(await orig<typeof import("@/lib/email/smtp.js")>()), isSmtpConfigured: async () => false }));

const { issueQuote, acceptQuoteByClient } = await import("@/lib/invoices/transitions.js");
const { createSubscriptionCheckoutSession, createMilestoneCheckoutSession } = await import("@/lib/stripe/checkout.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake") } });
  invalidateCompanySettingsCache();
  for (const m of [stripeMock.coupons.retrieve, stripeMock.coupons.create, stripeMock.checkout.sessions.create]) m.mockClear();
});

/** Devis émis : A paiement unique (2 400 €, en 2 fois), B abonnement annuel (1 500 €) avec la remise d'ouverture. */
async function issued() {
  const client = await createClient({ displayName: "Atelier Formules Stripe", type: "B2B" });
  await prisma.client.update({ where: { id: client.id }, data: { stripeCustomerId: "cus_test", stripeCustomerLivemode: false } });
  const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
  const quote = await prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType: "QUOTE",
      quoteStatus: "DRAFT",
      subtotalCents: 150000,
      totalCents: 150000,
      options: {
        create: [
          { position: 0, label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "TWO", subtotalCents: 240000, totalCents: 240000 },
          {
            position: 1,
            label: "Abonnement 3 ans",
            billingMode: "RECURRING",
            paymentPlanOffer: "NONE",
            recurringDiscountKind: "PERCENT",
            recurringDiscountValue: 3000,
            recurringDiscountMonths: 12,
            openingDiscount: true,
            subtotalCents: 150000,
            totalCents: 150000,
          },
        ],
      },
    },
    include: { options: { orderBy: { position: "asc" } } },
  });
  const [a, b] = quote.options;
  await prisma.invoiceLine.createMany({
    data: [
      { invoiceId: quote.id, optionId: a!.id, position: 1, description: "Création du site vitrine", quantity: 1, unitPriceCents: 240000, lineTotalCents: 240000 },
      {
        invoiceId: quote.id,
        optionId: b!.id,
        position: 2,
        description: "Site tout compris",
        quantity: 1,
        unitPriceCents: 150000,
        lineTotalCents: 150000,
        isSubscription: true,
        billingDay: 1,
        billingInterval: "YEAR",
        serviceId: svc.id,
        commitmentMonths: 36,
      },
    ],
  });
  await issueQuote(quote.id);
  return { quoteId: quote.id, clientId: client.id, a: a!, b: b! };
}

describe("devis à propositions signé, Stripe actif", () => {
  it("B : un seul abonnement, celui de B, prélèvement au montant de B, remise de B en coupon", async () => {
    const { quoteId, clientId, b } = await issued();
    await acceptQuoteByClient(quoteId, "Léa Martin", { source: "ADMIN", optionId: b.id });

    const subs = await prisma.subscription.findMany({ where: { clientId } });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ amountCents: 150000, billingInterval: "YEAR", discountKind: "PERCENT", discountValue: 3000, discountPeriods: 1 });
    expect(await prisma.paymentMilestone.count({ where: { quoteId } })).toBe(0);

    stripeMock.coupons.retrieve.mockRejectedValueOnce(Object.assign(new Error("No such coupon"), { code: "resource_missing" }));
    stripeMock.coupons.create.mockImplementationOnce(async (p: { id: string }) => ({ id: p.id }));
    await createSubscriptionCheckoutSession(subs[0]!.id);
    const params = (stripeMock.checkout.sessions.create.mock.calls.at(-1) as unknown[])[0] as Record<string, unknown>;
    expect(params).toMatchObject({ mode: "subscription", discounts: [{ coupon: `kouzia-${subs[0]!.id}-1x-p3000` }] });
    expect(JSON.stringify(params)).toContain("150000");
    expect(JSON.stringify(params)).not.toContain("240000");
    expect(stripeMock.coupons.create).toHaveBeenCalledWith(expect.objectContaining({ percent_off: 30, duration: "repeating" }));
  });

  it("A : aucun abonnement, 1er jalon de A exigible, session Checkout à son montant", async () => {
    const { quoteId, clientId, a } = await issued();
    await acceptQuoteByClient(quoteId, "Léa Martin", { source: "ADMIN", optionId: a.id });

    expect(await prisma.subscription.count({ where: { clientId } })).toBe(0);
    const milestones = await prisma.paymentMilestone.findMany({ where: { quoteId }, orderBy: { position: "asc" } });
    expect(milestones).toHaveLength(2);
    expect(milestones.reduce((s, m) => s + m.amountCents, 0)).toBe(240000);
    const first = milestones[0]!;
    expect(first.status).toBe("DUE");

    stripeMock.checkout.sessions.create.mockClear();
    await createMilestoneCheckoutSession(first.id);
    const params = (stripeMock.checkout.sessions.create.mock.calls.at(-1) as unknown[])[0] as { mode: string; line_items: Array<{ price_data: { unit_amount: number } }> };
    expect(params.mode).toBe("payment");
    expect(params.line_items[0]!.price_data.unit_amount).toBe(first.amountCents);
  });
});
