import { describe, expect, it } from "vitest";
import { proposalTitle } from "@/lib/quote-totals";

describe("proposalTitle", () => {
  it("lettre seule quand le libellé est vide ou répète la lettre", () => {
    expect(proposalTitle("A", "")).toBe("Proposition A");
    expect(proposalTitle("B", "Proposition B")).toBe("Proposition B");
  });
  it("lettre et libellé sinon", () => {
    expect(proposalTitle("A", "Abonnement annuel")).toBe("Proposition A : Abonnement annuel");
  });
});
