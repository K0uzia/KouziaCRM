import { describe, expect, it } from "vitest";
import { monthlyEquivalentCents, monthlyEquivalentText, periodSuffix } from "@/lib/billing-interval";
import { buildIssueEmailDraft } from "@/lib/issue-email";
import { formatEUR } from "@/lib/api";
import { mixedQuoteTotals, subscriptionsTotalText } from "@/lib/quote-totals";
import { billedPeriodsIn, commitmentTotalCents } from "@/lib/payment-summary";

/** Audit du 28/10/2026 : le trimestriel n'est plus compté comme un mois, et le brouillon d'e-mail d'émission dit vrai. */

describe("abonnement trimestriel (SubscriptionsPage)", () => {
  it("équivalent mensuel d'un abonnement trimestriel de 300 € = 100 €", () => {
    expect(monthlyEquivalentCents(30000, "QUARTER")).toBe(10000);
    expect(monthlyEquivalentText(30000, "QUARTER")).toContain("100,00");
  });
  it("suffixe d'un abonnement trimestriel = « / trimestre »", () => {
    expect(periodSuffix("QUARTER")).toBe("/ trimestre");
  });
});

describe("sous-total des abonnements d'un devis mixte", () => {
  it("un abonnement trimestriel n'est pas annoncé « par mois »", () => {
    const t = mixedQuoteTotals(
      [
        { isSubscription: false, unitPriceCents: 100000, lineTotalCents: 100000 },
        { isSubscription: true, unitPriceCents: 30000, billingInterval: "QUARTER" },
        { isSubscription: true, unitPriceCents: 2900, billingInterval: "MONTH" },
      ],
      130000,
      130000,
      100000,
    );
    expect(subscriptionsTotalText(t)).toBe(`${formatEUR(30000)} par trimestre + ${formatEUR(2900)} par mois`);
  });
  it("total d'engagement d'une ligne trimestrielle de 300 € sur 12 mois = 1 200 €", () => {
    expect(commitmentTotalCents(30000, "QUARTER", 12)).toBe(120000);
  });
});

describe("échéances dans l'engagement (éditeur)", () => {
  it("3 mois offerts sur 12 mois : 9 échéances mensuelles", () => {
    expect(billedPeriodsIn(12, "MONTH", { subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: "3" })).toBe(9);
  });
  it("1re facture le 1er mars 2027, signé le 1er novembre 2026 : 3 trimestres dans l'engagement", () => {
    expect(billedPeriodsIn(12, "QUARTER", { subscriptionStart: "DATE", subscriptionStartDate: "2027-03-01" }, new Date(2026, 10, 1, 10))).toBe(3);
  });
});

describe("brouillon d'e-mail d'émission (issue-email.ts)", () => {
  it("option en attente : proposée « au choix », jamais annoncée comme un abonnement compris", () => {
    const { body } = buildIssueEmailDraft(
      {
        client: { displayName: "Asso Exemple" },
        totalCents: 165000,
        subtotalCents: 165000,
        depositBaseCents: 165000,
        lines: [
          { description: "Site vitrine", unitPriceCents: 165000, lineTotalCents: 165000 },
          { description: "Maintenance annuelle", isSubscription: true, billingInterval: "YEAR", unitPriceCents: 65000, lineTotalCents: 65000, isOptional: true, optionalAccepted: null, commitmentMonths: 12 },
        ],
      },
      "QUOTE",
    );
    expect(body).not.toContain("Ce devis comprend aussi un abonnement");
    expect(body).toContain(`d'un montant de ${formatEUR(165000)}`);
    expect(body).toContain("Option au choix");
    expect(body).toContain(`Maintenance annuelle : ${formatEUR(65000)} par an, engagement de 12 mois à partir de la livraison.`);
  });

  it("devis à 2 propositions : chaque formule à part, sans « total du projet » commun", () => {
    const { body } = buildIssueEmailDraft(
      {
        client: { displayName: "Asso Exemple" },
        totalCents: 10000,
        subtotalCents: 10000,
        depositBaseCents: null,
        options: [
          { id: "a", position: 1, label: "Paiement unique" },
          { id: "b", position: 2, label: "Abonnement" },
        ],
        lines: [
          { description: "Site vitrine", unitPriceCents: 200000, lineTotalCents: 200000, optionId: "a" },
          { description: "Site en abonnement", isSubscription: true, billingInterval: "MONTH", unitPriceCents: 10000, lineTotalCents: 10000, optionId: "b" },
        ],
      },
      "QUOTE",
    );
    expect(body).not.toContain("total du projet");
    expect(body).toContain("2 formules au choix");
    expect(body).toContain(`- Proposition A : Paiement unique : ${formatEUR(200000)}`);
    expect(body).toContain(`- Proposition B : Abonnement : ${formatEUR(10000)} par mois`);
  });
});
