import { describe, expect, it } from "vitest";
import { shortNature } from "../receipt-nature";

describe("nature d'un encaissement à l'écran", () => {
  it("retire la partie qui répète le type de la colonne Type", () => {
    expect(shortNature("Acompte de 30% sur devis D-2026-0002 : Acompte - À la validation du devis", "Acompte")).toBe(
      "Acompte de 30% sur devis D-2026-0002",
    );
    expect(shortNature("Avoir · Refonte du site", "Avoir")).toBe("Refonte du site");
  });

  it("garde une nature sans répétition, même avec un « : »", () => {
    const n = "Intervention ponctuelle : Dépannage ou petite modification hors contrat de maintenance";
    expect(shortNature(n, "Facture")).toBe(n);
    expect(shortNature("Solde restant dû sur devis D-2026-0002", "Solde")).toBe("Solde restant dû sur devis D-2026-0002");
    expect(shortNature("Recette abonnement échéance (13/10/2026 - 13/10/2026)", "Abonnement")).toBe(
      "Recette abonnement échéance (13/10/2026 - 13/10/2026)",
    );
  });
});
