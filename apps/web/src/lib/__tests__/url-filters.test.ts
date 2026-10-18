import { describe, expect, it } from "vitest";
import { withParam } from "../use-url-filters";

describe("une seule clé changée, les autres filtres gardés", () => {
  it("bandeau des factures : retard ajouté puis retiré sans perdre type, statut ni recherche", () => {
    const current = "type=factures&statut=a-encaisser&q=atelier";
    const on = withParam(current, "retard", "1");
    expect(new URLSearchParams(on)).toEqual(new URLSearchParams("type=factures&statut=a-encaisser&q=atelier&retard=1"));
    expect(withParam(on.slice(1), "retard", null)).toBe("?type=factures&statut=a-encaisser&q=atelier");
  });

  it("changement de dossier dans un fil : « afficher » retiré, expéditeurs et recherche gardés", () => {
    expect(withParam("?expediteurs=clients&afficher=non-lus&q=devis", "afficher", null)).toBe("?expediteurs=clients&q=devis");
    expect(withParam("?afficher=favoris", "afficher", null)).toBe("");
  });

  it("valeur encodée et paramètres de type URLSearchParams", () => {
    expect(withParam(new URLSearchParams("q=a b"), "relire", "1")).toBe("?q=a+b&relire=1");
  });
});
