import { describe, expect, it } from "vitest";
import { proposalTitle, splitLineLabel, withOptionText, withoutFinalPeriod } from "@/lib/quote-totals";

describe("proposalTitle", () => {
  it("lettre seule quand le libellé est vide ou répète la lettre", () => {
    expect(proposalTitle("A", "")).toBe("Proposition A");
    expect(proposalTitle("B", "Proposition B")).toBe("Proposition B");
  });
  it("lettre et libellé sinon", () => {
    expect(proposalTitle("A", "Abonnement annuel")).toBe("Proposition A : Abonnement annuel");
  });
});

describe("phrases de l'option au choix", () => {
  it("total du projet plus l'option sur toute la durée d'engagement", () => {
    const n = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
    expect(n(withOptionText(165000, 65000, 12))).toBe("1 650,00 € + 650,00 € par an, soit 2 300,00 € sur les 12 mois d'engagement");
    expect(n(withOptionText(165000, 65000, 24))).toBe("1 650,00 € + 650,00 € par an, soit 2 950,00 € sur les 24 mois d'engagement");
  });
  it("libellé sans point final", () => {
    expect(withoutFinalPeriod("Maintenance : sauvegardes et corrections. ")).toBe("Maintenance : sauvegardes et corrections");
    expect(withoutFinalPeriod("Sans point")).toBe("Sans point");
  });
});

describe("libellé de l'option séparé en nom et description", () => {
  it("nom avant « : », description avec majuscule et point final", () => {
    expect(splitLineLabel("Maintenance site : hébergement du site, sauvegardes")).toEqual({ title: "Maintenance site", details: "Hébergement du site, sauvegardes." });
    expect(splitLineLabel("Maintenance annuelle.")).toEqual({ title: "Maintenance annuelle", details: null });
  });
});
