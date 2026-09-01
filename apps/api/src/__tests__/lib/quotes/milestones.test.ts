import { describe, expect, it } from "vitest";
import {
  computeMilestoneAmounts,
  DEFAULT_MILESTONE_TEMPLATE,
} from "@/lib/quotes/milestones.js";

describe("computeMilestoneAmounts", () => {
  it("répartit acompte + solde et place l'arrondi sur le solde", () => {
    const rows = computeMilestoneAmounts(100001);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      label: "Acompte",
      percentBps: 3000,
      amountCents: 30000,
    });
    expect(rows[1]).toMatchObject({
      label: "Solde",
      percentBps: 7000,
      amountCents: 70001,
    });
    expect(rows[0]!.amountCents + rows[1]!.amountCents).toBe(100001);
  });

  it("utilise le modèle par défaut à deux jalons", () => {
    expect(DEFAULT_MILESTONE_TEMPLATE.map((m) => m.label)).toEqual([
      "Acompte",
      "Solde",
    ]);
    expect(
      DEFAULT_MILESTONE_TEMPLATE.reduce((s, m) => s + m.percentBps, 0),
    ).toBe(10000);
  });
});
