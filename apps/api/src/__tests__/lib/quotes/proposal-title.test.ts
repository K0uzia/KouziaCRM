import { describe, expect, it } from "vitest";
import { proposalTitle } from "@/lib/quotes/quote-options.js";

describe("proposalTitle", () => {
  it("lettre seule quand le libellé est vide ou répète la lettre", () => {
    expect(proposalTitle("A", "")).toBe("Proposition A");
    expect(proposalTitle("A", "  ")).toBe("Proposition A");
    expect(proposalTitle("B", "Proposition B")).toBe("Proposition B");
    expect(proposalTitle("A", "proposition a")).toBe("Proposition A");
  });
  it("lettre et libellé sinon", () => {
    expect(proposalTitle("A", "Paiement unique")).toBe("Proposition A : Paiement unique");
    expect(proposalTitle("B", "Proposition A")).toBe("Proposition B : Proposition A");
  });
});
