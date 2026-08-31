import { describe, expect, it } from "vitest";
import { formatInvoiceNumber } from "@/lib/invoices/numberingService";
import { eurosToCents, lineTotalCents, formatEUR } from "@/lib/money";
import { computeLineTotals } from "@/lib/invoices/totals";
import { monthBounds, previousMonth, currentMonth } from "@/lib/finance/dates";
import {
  resolveDeclarationPeriod,
  resolveEcheanceStatus,
} from "@/lib/finance/urssaf-echeance";
import { computeUrssafDueCents } from "@/lib/publicodes";

describe("formatInvoiceNumber", () => {
  it("pads sequence to 4 digits with F- prefix", () => {
    expect(formatInvoiceNumber(2026, 1)).toBe("F-2026-0001");
    expect(formatInvoiceNumber(2026, 12)).toBe("F-2026-0012");
    expect(formatInvoiceNumber(2026, 100)).toBe("F-2026-0100");
  });

  it("keeps continuous sequence simulation without holes", () => {
    let last = 0;
    const allocated: string[] = [];
    for (let i = 0; i < 5; i++) {
      last += 1;
      allocated.push(formatInvoiceNumber(2026, last));
    }
    expect(allocated).toEqual([
      "F-2026-0001",
      "F-2026-0002",
      "F-2026-0003",
      "F-2026-0004",
      "F-2026-0005",
    ]);
  });
});

describe("URSSAF échéance M/M+1", () => {
  it("resolves previous month period for MONTHLY", () => {
    const now = new Date(2026, 7, 3);
    const p = resolveDeclarationPeriod("MONTHLY", 5, now);
    expect(p.periodKey).toBe("2026-07");
    expect(p.label).toContain("juillet");
    expect(p.deadline.getDate()).toBe(5);
    expect(p.deadline.getMonth()).toBe(7);
  });

  it("marks paid / clear / late correctly", () => {
    const deadline = new Date(2026, 7, 5);
    expect(
      resolveEcheanceStatus({
        amountDueCents: 0,
        isPaid: false,
        deadline,
        now: new Date(2026, 7, 24),
      }),
    ).toBe("clear");
    expect(
      resolveEcheanceStatus({
        amountDueCents: 1000,
        isPaid: true,
        deadline,
        now: new Date(2026, 7, 24),
      }),
    ).toBe("paid");
    expect(
      resolveEcheanceStatus({
        amountDueCents: 1000,
        isPaid: false,
        deadline,
        now: new Date(2026, 7, 24),
      }),
    ).toBe("late");
  });
});

describe("publicodes URSSAF", () => {
  it("computes non-zero due for 1500€ encaisse", () => {
    const due = computeUrssafDueCents(1_500_00);
    expect(due).toBeGreaterThan(0);
    // taux effectif AE BNC ~25% dans modele-social actuel (pas hardcodé 21.3)
    expect(due).toBeGreaterThan(300_00);
    expect(due).toBeLessThan(500_00);
  });

  /**
   * Le CA de la période est injecté en "€/mois" quelle que soit la périodicité
   * (voir publicodes.ts). C'est exact tant que le taux reste proportionnel.
   * Si modele-social introduit un seuil, ce test casse et signale que le mode
   * trimestriel doit être recalculé mois par mois.
   */
  it("stays proportional so quarterly equals three months", () => {
    const monthly = computeUrssafDueCents(2_000_00);
    const quarterly = computeUrssafDueCents(6_000_00);
    expect(quarterly).toBe(monthly * 3);
  });
});

describe("monthBounds", () => {
  it("handles january previous and february end", () => {
    const jan = currentMonth(new Date(2026, 0, 15));
    expect(jan.start.getDate()).toBe(1);
    expect(jan.end.getDate()).toBe(31);
    const prev = previousMonth(new Date(2026, 0, 15));
    expect(prev).toEqual(monthBounds(2025, 12));
    const feb = monthBounds(2026, 2);
    expect(feb.end.getDate()).toBe(28);
  });
});

describe("money", () => {
  it("converts euros to cents with half-up", () => {
    expect(eurosToCents(10.5)).toBe(1050);
    expect(eurosToCents("19.99")).toBe(1999);
    expect(lineTotalCents(2.5, 1000)).toBe(2500);
    expect(formatEUR(1999)).toMatch(/19/);
  });
});

describe("computeLineTotals", () => {
  it("sums line totals in cents", () => {
    const result = computeLineTotals([
      { description: "A", quantity: 1, unitPriceCents: 5000 },
      { description: "B", quantity: 2, unitPriceCents: 2500 },
    ]);
    expect(result.totalCents).toBe(10000);
    expect(result.lines).toHaveLength(2);
  });
});
