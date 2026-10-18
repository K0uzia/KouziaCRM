import { describe, expect, it } from "vitest";
import { eurosInputToCents, monthlyEquivalentText } from "../billing-interval";

const NBSP = " ";

describe("équivalent mensuel d'un abonnement annuel", () => {
  it("annuel : « soit … par mois », arrondi au centime le plus proche ; mensuel ou nul : rien", () => {
    expect(monthlyEquivalentText(35_000, "YEAR")).toBe(`soit 29,17${NBSP}€ par mois`); // 2 916,67 c -> 2 917 c
    expect(monthlyEquivalentText(12_000, "YEAR")).toBe(`soit 10,00${NBSP}€ par mois`);
    expect(monthlyEquivalentText(1_000, "YEAR")).toBe(`soit 0,83${NBSP}€ par mois`); // 83,33 c -> 83 c
    expect(monthlyEquivalentText(2_900, "MONTH")).toBeNull();
    expect(monthlyEquivalentText(0, "YEAR")).toBeNull();
  });

  it("prix saisi en euros vers centimes entiers, sans virgule flottante", () => {
    expect(eurosInputToCents("350")).toBe(35_000);
    expect(eurosInputToCents("350,5")).toBe(35_050);
    expect(eurosInputToCents("349.99")).toBe(34_999);
    expect(eurosInputToCents("0.29")).toBe(29);
    expect(eurosInputToCents("")).toBe(0);
    expect(eurosInputToCents("abc")).toBe(0);
  });
});
