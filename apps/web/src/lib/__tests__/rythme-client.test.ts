import { describe, expect, it } from "vitest";
import { annualEurosOf, DEFAULT_RECURRING, intervalRowsOf, offeredIntervalsOf, offeredIntervalsPayload, recurringFromLine, toggleInterval } from "@/components/documents/billing-mode-blocks";
import { periodAmountCents } from "@/lib/payment-summary";

// Rythme au choix du client (décisions d'Alexandre du 28/10/2026) : mêmes montants que l'API, le PDF et /suivi.
describe("éditeur : rythme de paiement au choix du client", () => {
  it("prix d'une échéance : fonction partagée avec l'API (1 mois offert : 136,36 € et 409,09 €)", () => {
    expect(periodAmountCents(150000, "YEAR", 1)).toBe(150000);
    expect(periodAmountCents(150000, "MONTH", 1)).toBe(13636);
    expect(periodAmountCents(150000, "QUARTER", 1)).toBe(40909);
  });

  it("nouveau devis : les trois rythmes cochés ; décocher garde au moins un rythme, le rythme des lignes suit", () => {
    expect(DEFAULT_RECURRING.intervals).toEqual(["YEAR", "QUARTER", "MONTH"]);
    expect(offeredIntervalsPayload(DEFAULT_RECURRING)).toEqual(["YEAR", "QUARTER", "MONTH"]);
    const two = toggleInterval(DEFAULT_RECURRING, "QUARTER", false);
    expect(two).toEqual({ intervals: ["YEAR", "MONTH"], interval: "YEAR" });
    const one = toggleInterval(two, "YEAR", false);
    expect(one).toEqual({ intervals: ["MONTH"], interval: "MONTH" });
    expect(offeredIntervalsPayload(one)).toBeNull();
    expect(toggleInterval(one, "MONTH", false).intervals).toEqual(["MONTH"]);
  });

  it("tableau des rythmes : prix par échéance et total sur l'engagement, comme le PDF", () => {
    const rows = intervalRowsOf({ ...DEFAULT_RECURRING, commitmentMonths: "12" }, [150000], 1);
    expect(rows.map((r) => [r.interval, r.amountCents, r.totalCommitmentCents])).toEqual([
      ["YEAR", 150000, 150000],
      ["QUARTER", 40909, 163636],
      ["MONTH", 13636, 163632],
    ]);
    expect(intervalRowsOf({ ...DEFAULT_RECURRING, intervals: ["MONTH"] }, [150000], 1)).toEqual([]);
  });

  it("brouillon rouvert : rythmes et prix annuel repris", () => {
    const line = { billingInterval: "YEAR", billingDay: 1, commitmentMonths: 12, subscriptionStart: "" as const, subscriptionStartDate: "", subscriptionFreeMonths: "" };
    expect(recurringFromLine(line, "YEAR,MONTH")).toMatchObject({ interval: "YEAR", intervals: ["YEAR", "MONTH"] });
    expect(recurringFromLine({ ...line, billingInterval: "MONTH" }, null)).toMatchObject({ interval: "MONTH", intervals: ["MONTH"] });
    expect(offeredIntervalsOf("YEAR")).toEqual([]);
    expect(annualEurosOf(150000, "YEAR", 1)).toBe("1500.00");
    // Mensuel enregistré (un seul rythme) : réciproque de la conversion, le prix mensuel est gardé.
    expect(annualEurosOf(13636, "MONTH", 1)).toBe("1499.96");
    expect(periodAmountCents(149996, "MONTH", 1)).toBe(13636);
  });
});
