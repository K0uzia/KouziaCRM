import { describe, expect, it } from "vitest";
import { belowOnlineMinimum, quoteOnlineMinimumWarning } from "@/lib/stripe/minimum.js";

const settings = {
  depositPercent1Bps: 3000,
  depositPercent2Bps: 7000,
  depositPercent3Bps: 0,
  split3Percent1Bps: 3000,
  split3Percent2Bps: 4000,
  split3Percent3Bps: 3000,
  split3MinTotalCents: 100_000,
  split3Step2TriggerText: "Maquette validée",
  installmentIntervalDays: 30,
} as Parameters<typeof quoteOnlineMinimumWarning>[2];

describe("minimum du paiement en ligne (0,50 €)", () => {
  it("seuil", () => {
    expect(belowOnlineMinimum(49)).toBe(true);
    expect(belowOnlineMinimum(50)).toBe(false);
    expect(belowOnlineMinimum(0)).toBe(false);
  });

  it("devis à 1 € en 2 fois : acompte de 0,30 € signalé", () => {
    const w = quoteOnlineMinimumWarning("TWO", 100, settings);
    expect(w).toContain("Paiement en ligne impossible sous 0,50");
    expect(w).toContain("0,30");
    expect(w).toContain("par virement");
  });

  it("devis à 2 € : rien à signaler", () => {
    expect(quoteOnlineMinimumWarning("TWO", 200, settings)).toBeNull();
  });
});
