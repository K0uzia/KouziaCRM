import { describe, expect, it } from "vitest";
import { isAssociationCategory, isOrganization } from "@/lib/clients/client-type.js";
import { clausesForClient } from "@/lib/company/legal-clauses.js";
import { buildDisplayName, clientInputSchema } from "@/lib/clients.js";

describe("type de client « Association »", () => {
  it("structure (professionnel ou association) contre particulier", () => {
    expect(isOrganization("B2B")).toBe(true);
    expect(isOrganization("ASSOCIATION")).toBe(true);
    expect(isOrganization("B2C")).toBe(false);
  });

  it("catégorie juridique INSEE 92xx = association", () => {
    expect(isAssociationCategory("9220")).toBe(true);
    expect(isAssociationCategory("9230")).toBe(true);
    expect(isAssociationCategory("5710")).toBe(false);
    expect(isAssociationCategory(null)).toBe(false);
  });

  // Défaut du 26/10/2026 : aucun public ne couvrait les associations. Publics « Associations » et « Associations et
  // particuliers » ; jamais les clauses des particuliers seuls (rétractation) ni celles des professionnels (40 €).
  it("clauses : une association reçoit « tous », « associations » et « associations et particuliers », rien d'autre", () => {
    const list = [
      { audience: "ALL" as const, title: "TVA" },
      { audience: "B2B" as const, title: "Pénalités" },
      { audience: "B2C" as const, title: "Rétractation" },
      { audience: "ASSOCIATION" as const, title: "Mention associations" },
      { audience: "NON_PROFESSIONAL" as const, title: "Intérêts" },
    ];
    expect(clausesForClient(list, "ASSOCIATION").map((c) => c.title)).toEqual(["TVA", "Mention associations", "Intérêts"]);
    expect(clausesForClient(list, "B2C").map((c) => c.title)).toEqual(["TVA", "Rétractation", "Intérêts"]);
    expect(clausesForClient(list, "B2B").map((c) => c.title)).toEqual(["TVA", "Pénalités"]);
    expect(clausesForClient(list, null).map((c) => c.title)).toEqual(["TVA"]);
  });

  it("fiche admin : nom de l'association obligatoire, nom affiché = nom de l'association", () => {
    const missing = clientInputSchema.safeParse({ type: "ASSOCIATION", companyName: " " });
    expect(missing.success).toBe(false);
    expect(JSON.stringify(missing.error?.flatten().fieldErrors)).toContain("Nom de l'association requis");
    const ok = clientInputSchema.parse({ type: "ASSOCIATION", companyName: "Les Amis du Moulin" });
    expect(buildDisplayName(ok)).toBe("Les Amis du Moulin");
  });
});
