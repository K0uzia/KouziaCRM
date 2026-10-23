import { describe, expect, it } from "vitest";
import { commitmentTotalCents, installments, oneOffMeans, orList, plansShown, subscriptionMeans, type PaymentSettings } from "@/lib/payment-summary";

const s: PaymentSettings = {
  depositPercent1Bps: 3000,
  depositPercent2Bps: 7000,
  split3Percent1Bps: 3000,
  split3Percent2Bps: 4000,
  split3Percent3Bps: 3000,
  split3MinTotalCents: 50000,
  paymentSepaEnabled: true,
  paymentCardEnabled: true,
  paymentCardMaxCents: 30000,
};

describe("récapitulatif de paiement", () => {
  it("échéances : arrondi au centime, le solde reçoit le reste", () => {
    expect(installments("TWO", 100001, s)).toEqual([
      { label: "Acompte", percentBps: 3000, amountCents: 30000 },
      { label: "Solde", percentBps: 7000, amountCents: 70001 },
    ]);
    expect(installments("THREE", 99999, s).map((i) => i.amountCents)).toEqual([30000, 40000, 29999]);
  });

  it("formules proposées : sous le seuil du 3 fois, 2 fois seulement", () => {
    expect(plansShown("CHOICE", 60000, s)).toEqual(["TWO", "THREE"]);
    expect(plansShown("THREE", 60000, s)).toEqual(["THREE"]);
    expect(plansShown("CHOICE", 49999, s)).toEqual(["TWO"]);
    expect(plansShown("", 90000, s)).toEqual(["TWO"]);
  });

  it("moyens : SEPA, virement, carte sous le seuil ; abonnement sans virement, carte en dernier recours", () => {
    expect(oneOffMeans(30000, s)).toEqual(["prélèvement SEPA", "virement", "carte bancaire"]);
    expect(oneOffMeans(30001, s)).toEqual(["prélèvement SEPA", "virement"]);
    expect(subscriptionMeans(150000, s)).toEqual(["prélèvement SEPA"]);
    expect(subscriptionMeans(150000, { ...s, paymentSepaEnabled: false })).toEqual(["carte bancaire"]);
    expect(orList(["prélèvement SEPA", "virement", "carte bancaire"])).toBe("prélèvement SEPA, virement ou carte bancaire");
  });

  it("engagement : 36 mois à l'année = 3 annuités, au mois = 36 mensualités", () => {
    expect(commitmentTotalCents(150000, "YEAR", 36)).toBe(450000);
    expect(commitmentTotalCents(9900, "MONTH", 12)).toBe(118800);
  });
});
