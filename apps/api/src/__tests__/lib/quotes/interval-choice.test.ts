import { describe, expect, it } from "vitest";
import { periodPriceOfAnnual } from "@/lib/services/annual-price.js";
import {
  choiceDiscountSentence,
  hasIntervalChoice,
  intervalChoiceError,
  intervalChoiceRows,
  longestPeriodMonths,
  offeredIntervalsValue,
  parseOfferedIntervals,
} from "@/lib/quotes/interval-choice.js";
import { NO_RECURRING_DISCOUNT, OPENING_DISCOUNT } from "@/lib/quotes/recurring-discount-calc.js";

// Rythme au choix du client (décisions d'Alexandre du 28/10/2026).
describe("rythme de paiement au choix du client", () => {
  it("prix d'une échéance : annuel tel quel, mensuel = annuel / (12 - mois offerts), trimestriel = 3 mensualités", () => {
    expect(periodPriceOfAnnual(150000, "YEAR", 1)).toBe(150000);
    expect(periodPriceOfAnnual(150000, "MONTH", 1)).toBe(13636);
    expect(periodPriceOfAnnual(150000, "QUARTER", 1)).toBe(40909);
    expect(periodPriceOfAnnual(150000, "MONTH", 0)).toBe(12500);
    expect(periodPriceOfAnnual(150000, "QUARTER", 2)).toBe(45000);
    // Réglage hors bornes : jamais de division par zéro.
    expect(periodPriceOfAnnual(120000, "MONTH", 12)).toBe(120000);
  });

  it("rythmes enregistrés : ordre d'affichage, sans doublon, null pour un seul", () => {
    expect(parseOfferedIntervals("MONTH,YEAR,MONTH,FOO")).toEqual(["YEAR", "MONTH"]);
    expect(parseOfferedIntervals(null)).toEqual([]);
    expect(offeredIntervalsValue(["MONTH", "QUARTER", "YEAR"])).toBe("YEAR,QUARTER,MONTH");
    expect(offeredIntervalsValue(["MONTH"])).toBeNull();
    expect(offeredIntervalsValue([])).toBeNull();
    expect(hasIntervalChoice("YEAR,MONTH")).toBe(true);
    expect(hasIntervalChoice("YEAR")).toBe(false);
    expect(longestPeriodMonths(["QUARTER", "MONTH"])).toBe(3);
    expect(longestPeriodMonths(["YEAR", "MONTH"])).toBe(12);
  });

  it("choix à la signature : obligatoire quand plusieurs rythmes, refusé s'il n'est pas proposé", () => {
    expect(intervalChoiceError(["YEAR", "MONTH"], undefined)).toBe("REQUIRED");
    expect(intervalChoiceError(["YEAR", "MONTH"], "QUARTER")).toBe("INVALID");
    expect(intervalChoiceError(["YEAR", "MONTH"], "WEEK")).toBe("INVALID");
    expect(intervalChoiceError(["YEAR", "MONTH"], "MONTH")).toBeNull();
    // Un seul rythme : rien à choisir ; un rythme envoyé doit être celui des lignes.
    expect(intervalChoiceError([], undefined, "MONTH")).toBeNull();
    expect(intervalChoiceError([], "MONTH", null)).toBeNull();
    expect(intervalChoiceError([], "YEAR", "MONTH")).toBe("INVALID");
  });

  it("tableau des rythmes : prix par échéance et total sur l'engagement, ligne par ligne", () => {
    const rows = intervalChoiceRows({
      offered: ["YEAR", "QUARTER", "MONTH"],
      annualLineCents: [150000],
      annualFreeMonths: 1,
      commitmentMonths: 12,
      discount: NO_RECURRING_DISCOUNT,
    });
    expect(rows.map((r) => [r.interval, r.amountCents, r.periods, r.totalCommitmentCents])).toEqual([
      ["YEAR", 150000, 1, 150000],
      ["QUARTER", 40909, 4, 163636],
      ["MONTH", 13636, 12, 163632],
    ]);
    // Deux lignes : chacune convertie puis arrondie, comme à la signature.
    const two = intervalChoiceRows({ offered: ["MONTH"], annualLineCents: [100000, 50000], annualFreeMonths: 1, commitmentMonths: 12, discount: NO_RECURRING_DISCOUNT });
    expect(two[0]!.amountCents).toBe(periodPriceOfAnnual(100000, "MONTH", 1) + periodPriceOfAnnual(50000, "MONTH", 1));
  });

  it("remise d'ouverture (30 % sur 12 mois, 36 mois) recomptée au rythme ; mois offerts au départ décomptés", () => {
    const opening = { recurringDiscountKind: "PERCENT", recurringDiscountValue: OPENING_DISCOUNT.value, recurringDiscountMonths: 12, openingDiscount: true };
    const rows = intervalChoiceRows({ offered: ["YEAR", "MONTH"], annualLineCents: [150000], annualFreeMonths: 1, commitmentMonths: 36, discount: opening });
    const [year, month] = rows;
    expect(year).toMatchObject({ amountCents: 150000, periods: 3, totalCommitmentCents: 150000 * 3 - 45000 });
    expect(year!.discount).toMatchObject({ periods: 1, discountCentsPerPeriod: 45000 });
    expect(month).toMatchObject({ amountCents: 13636, periods: 36 });
    expect(month!.discount).toMatchObject({ periods: 12, discountCentsPerPeriod: 4091 });
    expect(month!.totalCommitmentCents).toBe(13636 * 36 - 4091 * 12);
    // Départ à 3 mois offerts : 33 mensualités dans l'engagement, 3 annuités.
    const offset = intervalChoiceRows({ offered: ["YEAR", "MONTH"], annualLineCents: [150000], annualFreeMonths: 1, commitmentMonths: 36, offsetMonths: 3, discount: NO_RECURRING_DISCOUNT });
    expect(offset.map((r) => r.periods)).toEqual([3, 33]);
    expect(choiceDiscountSentence(year!.discount!)).toBe(
      "Remise d’ouverture : 30 % sur les 12 premiers mois, quel que soit le rythme, comprise dans les totaux sur l’engagement.",
    );
  });
});
