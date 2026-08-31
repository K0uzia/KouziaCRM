import { describe, expect, it } from "vitest";
import {
  cfeAmountForPaymentYear,
  clipPeriodToActivity,
  monthsActiveInCalendarYear,
  monthsElapsedSinceActivityStart,
  parseBusinessStartDateInput,
} from "@/lib/company/business-start.js";

describe("business-start", () => {
  const start = parseBusinessStartDateInput("2026-09-01");

  it("compte les mois actifs dans l'année de création", () => {
    expect(monthsActiveInCalendarYear(start, 2026)).toBe(4);
    expect(monthsActiveInCalendarYear(start, 2027)).toBe(12);
    expect(monthsActiveInCalendarYear(start, 2025)).toBe(0);
  });

  it("prorata CFE la première année", () => {
    expect(cfeAmountForPaymentYear(25000, start, 2026)).toBe(Math.round((25000 * 4) / 12));
    expect(cfeAmountForPaymentYear(25000, start, 2027)).toBe(25000);
    expect(cfeAmountForPaymentYear(25000, start, 2025)).toBeNull();
  });

  it("ignore les périodes avant le début d'activité", () => {
    expect(
      clipPeriodToActivity(
        new Date(2026, 7, 1),
        new Date(2026, 7, 31),
        start,
      ),
    ).toBeNull();
    const clipped = clipPeriodToActivity(
      new Date(2026, 8, 1),
      new Date(2026, 8, 30),
      start,
    );
    expect(clipped?.start.getMonth()).toBe(8);
  });

  it("calcule les mois écoulés pour la réserve CFE", () => {
    expect(monthsElapsedSinceActivityStart(start, new Date(2026, 8, 30))).toBe(1);
    expect(monthsElapsedSinceActivityStart(start, new Date(2026, 11, 31))).toBe(4);
    expect(monthsElapsedSinceActivityStart(start, new Date(2026, 7, 31))).toBe(0);
  });

  it("sans date de début, pas de CFE", () => {
    expect(cfeAmountForPaymentYear(25000, null, 2026)).toBeNull();
  });
});
