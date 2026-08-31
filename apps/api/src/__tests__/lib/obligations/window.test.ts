import { describe, expect, it } from "vitest";
import {
  incomeTaxClosesAt,
  resolveObligationWindow,
  urssafOpensAt,
  urssafClosesAt,
} from "@/lib/obligations/window.js";

describe("obligation window", () => {
  const settings = {
    businessStartDate: new Date(2026, 8, 1, 12, 0, 0, 0),
    incomeTaxReminderMonth: 4,
    incomeTaxReminderDay: 15,
  };

  it("URSSAF mensuel : ouverture 1er du mois suivant, clôture le 15", () => {
    const periodEnd = new Date(2026, 8, 30, 23, 59, 59, 999);
    expect(urssafOpensAt(periodEnd).getFullYear()).toBe(2026);
    expect(urssafOpensAt(periodEnd).getMonth()).toBe(9);
    expect(urssafOpensAt(periodEnd).getDate()).toBe(1);
    expect(urssafClosesAt(periodEnd).getMonth()).toBe(9);
    expect(urssafClosesAt(periodEnd).getDate()).toBe(15);

    const w = resolveObligationWindow(
      {
        type: "URSSAF_DECLARATION",
        period: "2026-09",
        dueDate: urssafClosesAt(periodEnd),
      },
      settings,
    );
    expect(w.opensAt.getMonth()).toBe(9);
    expect(w.closesAt.getDate()).toBe(15);
  });

  it("Impôts revenus N : ouverture avril N+1, clôture fin mai N+1", () => {
    const w = resolveObligationWindow(
      {
        type: "INCOME_TAX_DECLARATION",
        period: "2026",
        dueDate: incomeTaxClosesAt(2026),
      },
      settings,
    );
    expect(w.opensAt.getFullYear()).toBe(2027);
    expect(w.opensAt.getMonth()).toBe(3);
    expect(w.closesAt.getFullYear()).toBe(2027);
    expect(w.closesAt.getMonth()).toBe(4);
    expect(w.closesAt.getDate()).toBe(31);
  });

  it("CFE initiale : ouverture au début d'activité, clôture 31/12", () => {
    const w = resolveObligationWindow(
      {
        type: "CFE_INITIAL_DECLARATION",
        period: "INITIAL-2026",
        dueDate: new Date(2026, 11, 31, 23, 59, 59, 999),
      },
      settings,
    );
    expect(w.opensAt.getMonth()).toBe(8);
    expect(w.opensAt.getDate()).toBe(1);
    expect(w.closesAt.getMonth()).toBe(11);
    expect(w.closesAt.getDate()).toBe(31);
  });

  it("1re URSSAF (délai 90 j) : ouverture au début d'activité, clôture étendue", () => {
    const periodEnd = new Date(2026, 8, 30, 23, 59, 59, 999);
    const extendedClose = new Date(2026, 11, 15, 23, 59, 59, 999);
    const w = resolveObligationWindow(
      {
        type: "URSSAF_DECLARATION",
        period: "2026-09",
        dueDate: extendedClose,
      },
      settings,
    );
    expect(w.opensAt.getMonth()).toBe(8);
    expect(w.opensAt.getDate()).toBe(1);
    expect(w.closesAt.getMonth()).toBe(11);
    expect(w.closesAt.getDate()).toBe(15);
    expect(w.closesAt.getTime()).toBeGreaterThan(urssafClosesAt(periodEnd).getTime());
  });
});
