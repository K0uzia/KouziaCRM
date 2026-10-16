import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pagesValue } from "@/lib/site/contract.js";
import { pagesDefaultsFromContract } from "@/lib/site/pages.js";

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/site/${name}`, import.meta.url)), "utf8")) as unknown;

describe("textes actuels des pages (defauts.pages du contrat)", () => {
  it("contrat en ligne (b2b331c) : toutes les pages, conformes au schéma de pages.json, accent et variables compris", () => {
    const d = pagesDefaultsFromContract(fixture("contenu.schema.json"))!;
    expect(d).not.toBeNull();
    expect(Object.keys(d).sort()).toEqual(["aPropos", "accueil", "faq", "logiciels", "sitesWeb"]);
    expect(d.accueil?.hero?.titre).toMatch(/\*[^*]+\*/);
    expect(d.accueil?.hero?.surTitre).toContain("{ville}");
    // Valeurs reprises telles quelles dans un pages.json : elles passent le schéma de l'ERP.
    expect(pagesValue.safeParse({ pages: d }).success).toBe(true);
  });

  it("site antérieur au lot 6 (600dec6) : aucun texte actuel, null plutôt qu'un exemple inventé", () => {
    expect(pagesDefaultsFromContract(fixture("contenu.schema.600dec6.json"))).toBeNull();
    expect(pagesDefaultsFromContract(null)).toBeNull();
  });
});
