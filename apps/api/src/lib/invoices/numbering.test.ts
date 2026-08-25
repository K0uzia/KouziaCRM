import { describe, expect, it } from "vitest";
import { formatInvoiceNumber } from "@/lib/invoices/numbering";
import { estimateUrssafCents, bpsToRate, formatPercentFromBps } from "@/lib/urssaf";
import { eurosToCents, lineTotalCents, formatEUR } from "@/lib/money";
import { computeLineTotals } from "@/lib/invoices/totals";
import { splitEnvelopes } from "@/lib/finance/envelopes";
import { computeMonthlyCashflow } from "@/lib/finance/cashflow";
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

describe("urssaf BNC", () => {
  it("estimates 21.30% on encaissements", () => {
    expect(bpsToRate(2130)).toBeCloseTo(0.213);
    expect(estimateUrssafCents(100_00, 2130)).toBe(2130);
    expect(formatPercentFromBps(2130)).toContain("21,30");
  });
});

describe("splitEnvelopes", () => {
  it("splits CA into 21.30% / 14.20% / 10% / remainder", () => {
    const e = splitEnvelopes(10_000_00);
    expect(e.urssafCents).toBe(213_000);
    expect(e.treasuryCents).toBe(142_000);
    expect(e.salaryNetCents).toBe(10_000_00 - 213_000 - 142_000 - 100_000);
    expect(e.salaryRateBps).toBe(5450);
    expect(e.urssafCents + e.treasuryCents + 100_000 + e.salaryNetCents).toBe(e.caCents);
  });
});

describe("computeMonthlyCashflow", () => {
  it("builds waterfall without double-counting", () => {
    const c = computeMonthlyCashflow(1_500_00, 2026, 8);
    expect(c.totalEncaisseCents).toBe(1_500_00);
    expect(c.urssafCents + c.fraisCents + c.placementsCents).toBe(c.reservedCents);
    expect(c.totalEncaisseCents - c.reservedCents).toBe(c.resteNetCents);
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
