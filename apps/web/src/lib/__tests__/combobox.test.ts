import { describe, expect, it } from "vitest";
import { countOptions, filterGroups, findOption, searchKey, type ComboboxGroup } from "../combobox-filter";
import { catalogGroups, type CatalogService } from "../catalog-options";

const groups: ComboboxGroup[] = [
  {
    heading: "Sites",
    options: [
      { value: "a", label: "Site vitrine", meta: "1 200 €", metaDetail: "prix fixe", description: "Cinq pages, référencement local" },
      { value: "b", label: "Boutique en ligne", meta: "3 400 €", description: "Paiement et stocks" },
    ],
  },
  { heading: "Abonnements", options: [{ value: "c", label: "Maintenance annuelle", meta: "350 €", metaDetail: "/ an" }] },
];

describe("recherche d'une liste de choix", () => {
  it("ignore la casse et les accents", () => {
    expect(searchKey("  Référencement   LOCAL ")).toBe("referencement local");
    expect(countOptions(filterGroups(groups, "REFERENCEMENT"))).toBe(1);
  });

  it("exige chaque mot, dans n'importe quel ordre, nom, description ou titre du groupe compris", () => {
    expect(filterGroups(groups, "local vitrine").map((g) => g.options.map((o) => o.value))).toEqual([["a"]]);
    expect(filterGroups(groups, "abonnements").map((g) => g.heading)).toEqual(["Abonnements"]);
    expect(countOptions(filterGroups(groups, "vitrine boutique"))).toBe(0);
  });

  it("retire les groupes vides et rend tout sans recherche", () => {
    expect(filterGroups(groups, "stocks").map((g) => g.heading)).toEqual(["Sites"]);
    expect(countOptions(filterGroups(groups, "   "))).toBe(3);
  });

  it("retrouve l'option choisie", () => {
    expect(findOption(groups, "c")?.label).toBe("Maintenance annuelle");
    expect(findOption(groups, "")).toBeUndefined();
    expect(findOption(groups, "inconnu")).toBeUndefined();
  });
});

describe("catalogue en groupes", () => {
  const svc = (s: Partial<CatalogService> & { id: string }): CatalogService => ({ name: s.id, unitPriceCents: 10_000, ...s });

  it("ordonne Sites, Logiciels, Options, autres, Packs, Abonnements et masque les groupes vides", () => {
    const result = catalogGroups([
      svc({ id: "abo", isSubscription: true, billingInterval: "YEAR" }),
      svc({ id: "pack", isPack: true }),
      svc({ id: "libre" }),
      svc({ id: "option", category: "OPTION" }),
      svc({ id: "site", category: "SITE" }),
    ]);
    expect(result.map((g) => [g.heading, g.options.map((o) => o.value)])).toEqual([
      ["Sites", ["site"]],
      ["Options", ["option"]],
      ["Autres prestations", ["libre"]],
      ["Packs", ["pack"]],
      ["Abonnements", ["abo"]],
    ]);
  });

  it("montre prix, périodicité et description sur la ligne secondaire", () => {
    const [abo] = catalogGroups([svc({ id: "abo", isSubscription: true, billingInterval: "YEAR", unitPriceCents: 35_000, description: "  Mises à jour  " })])[0].options;
    expect(abo.meta).toMatch(/^350,00\s€$/);
    expect(abo.metaDetail).toBe("/ an");
    expect(abo.description).toBe("Mises à jour");
    const [pack] = catalogGroups([svc({ id: "p", isPack: true, description: "" })])[0].options;
    expect(pack.metaDetail).toBe("pack");
    expect(pack.description).toBeNull();
  });
});
