import { describe, expect, it } from "vitest";
import { computeDiscountCents, computeLineTotals } from "@/lib/invoices/totals.js";

// Audit du 27/10/2026 : partie ponctuelle à sous-total négatif (ligne libre à -10 €) et remise globale : Math.min(base,
// …) rendait une remise négative ; total = sous-total - remise gonflait le total, sans remise affichée.
describe("remise globale sur une base nulle ou négative", () => {
  it("aucune remise, le total reste le sous-total", () => {
    expect(computeDiscountCents(-1000, { discountType: "PERCENT", discountValue: 1000 })).toBe(0);
    expect(computeDiscountCents(0, { discountType: "FIXED", discountValue: 500 })).toBe(0);
    const t = computeLineTotals(
      [
        { description: "Maintenance", quantity: 1, unitPriceCents: 5000, isSubscription: true, billingDay: 1, serviceId: "svc" },
        { description: "Geste commercial", quantity: 1, unitPriceCents: -1000 },
      ],
      { discountType: "PERCENT", discountValue: 1000 },
    );
    expect(t.discountCents).toBe(0);
    expect(t.totalCents).toBe(t.subtotalCents);
  });

  it("base positive : remise inchangée", () => {
    expect(computeDiscountCents(10_000, { discountType: "PERCENT", discountValue: 1000 })).toBe(1000);
    expect(computeDiscountCents(10_000, { discountType: "FIXED", discountValue: 20_000 })).toBe(10_000);
  });
});
