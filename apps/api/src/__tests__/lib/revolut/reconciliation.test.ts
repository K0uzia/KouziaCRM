import { describe, expect, it } from "vitest";
import {
  extractDocumentNumbers,
  namesFuzzyMatch,
  normalizeName,
} from "@/lib/revolut/reconciliationService.js";

describe("reconciliation helpers", () => {
  it("extrait les numéros F/D/A", () => {
    expect(extractDocumentNumbers("Virement F-2026-0031 merci")).toContain(
      "F-2026-0031",
    );
    expect(extractDocumentNumbers("ref A-2025-12")).toEqual(
      expect.arrayContaining(["A-2025-0012", "A-2025-12"]),
    );
  });

  it("matching flou de noms", () => {
    expect(namesFuzzyMatch("SARL Dupont Martin", "Dupont Martin")).toBe(true);
    expect(namesFuzzyMatch("Martin Dupont", "Dupont Martin")).toBe(true);
    expect(namesFuzzyMatch("Acme SA", "Autre SARL")).toBe(false);
    expect(normalizeName("Café Étoile")).toBe("cafe etoile");
  });
});
