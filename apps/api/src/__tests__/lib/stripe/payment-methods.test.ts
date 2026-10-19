import { describe, expect, it } from "vitest";
import { cardAllowed, paymentMethodTypes, primaryMethod, subscriptionMethodTypes } from "@/lib/stripe/payment-methods.js";
import { dailyIdempotencyKey } from "@/lib/stripe/idempotency.js";

const defaults = { paymentSepaEnabled: true, paymentCardEnabled: true, paymentCardMaxCents: 30_000 };

describe("moyens proposés sur un lien Stripe (décisions du 19/10/2026)", () => {
  it("paiement ponctuel : SEPA, virement Stripe, puis carte jusqu'au seuil inclus", () => {
    expect(paymentMethodTypes(30_000, defaults)).toEqual(["sepa_debit", "customer_balance", "card"]);
    expect(paymentMethodTypes(30_001, defaults)).toEqual(["sepa_debit", "customer_balance"]);
    expect(paymentMethodTypes(150_000, { ...defaults, paymentSepaEnabled: false })).toEqual(["customer_balance"]);
    expect(cardAllowed(5_000, { ...defaults, paymentCardEnabled: false })).toBe(false);
  });

  it("abonnement : SEPA seul au-delà du seuil, carte en dessous, jamais vide", () => {
    expect(subscriptionMethodTypes(150_000, defaults)).toEqual(["sepa_debit"]);
    expect(subscriptionMethodTypes(7_200, defaults)).toEqual(["sepa_debit", "card"]);
    expect(subscriptionMethodTypes(150_000, { ...defaults, paymentSepaEnabled: false })).toEqual(["card"]);
  });

  it("moyen principal pour /suivi et les e-mails", () => {
    expect(primaryMethod(150_000, defaults)).toBe("sepa_debit");
    expect(primaryMethod(5_000, { ...defaults, paymentSepaEnabled: false })).toBe("card");
    expect(primaryMethod(150_000, { ...defaults, paymentSepaEnabled: false })).toBe("bank_transfer");
  });

  it("clé d'idempotence : même jour et mêmes paramètres = même clé ; autre montant ou autre jour = autre clé", () => {
    const at = new Date("2026-10-19T10:00:00Z");
    const a = dailyIdempotencyKey("checkout", { amount: 1 }, at);
    expect(dailyIdempotencyKey("checkout", { amount: 1 }, new Date("2026-10-19T21:00:00Z"))).toBe(a);
    expect(dailyIdempotencyKey("checkout", { amount: 2 }, at)).not.toBe(a);
    // 23 h 30 à Paris le 19 = 21 h 30 UTC : encore le 19 ; 22 h 30 UTC = 0 h 30 le 20 à Paris.
    expect(dailyIdempotencyKey("checkout", { amount: 1 }, new Date("2026-10-19T22:30:00Z"))).not.toBe(a);
  });
});
