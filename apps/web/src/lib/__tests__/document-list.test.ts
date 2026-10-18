import { describe, expect, it } from "vitest";
import { CREDIT_ISSUED, INVOICE_STATUS_SLUG, isOverdue, listStatus, QUOTE_STATUS_SLUG } from "../document-list";
import { matchesSearch } from "../list-search";

const now = new Date(2026, 9, 18, 15, 0);
const invoice = (status: string, dueDate: string | null) => ({ documentType: "INVOICE", status, dueDate });

describe("échéance dépassée", () => {
  it("facture émise dont l'échéance est la veille ou avant", () => {
    expect(isOverdue(invoice("ISSUED", new Date(2026, 9, 17).toISOString()), now)).toBe(true);
    expect(isOverdue(invoice("ISSUED", new Date(2026, 8, 1).toISOString()), now)).toBe(true);
  });

  it("pas avant la fin du jour d'échéance, ni pour une facture réglée, annulée, brouillon ou sans échéance", () => {
    expect(isOverdue(invoice("ISSUED", new Date(2026, 9, 18).toISOString()), now)).toBe(false);
    expect(isOverdue(invoice("ISSUED", new Date(2026, 9, 25).toISOString()), now)).toBe(false);
    for (const status of ["PAID", "CANCELLED", "DRAFT"]) expect(isOverdue(invoice(status, new Date(2026, 8, 1).toISOString()), now)).toBe(false);
    expect(isOverdue(invoice("ISSUED", null), now)).toBe(false);
  });

  it("un avoir ou un devis n'est jamais en retard", () => {
    const old = new Date(2026, 8, 1).toISOString();
    expect(isOverdue({ documentType: "CREDIT_NOTE", status: "ISSUED", dueDate: old }, now)).toBe(false);
    expect(isOverdue({ documentType: "QUOTE", status: "ISSUED", dueDate: old }, now)).toBe(false);
  });
});

describe("statut de la liste", () => {
  it("avoir émis : statut à part, jamais « à encaisser »", () => {
    expect(listStatus({ documentType: "CREDIT_NOTE", status: "ISSUED" }, false)).toBe(CREDIT_ISSUED);
    expect(listStatus({ documentType: "INVOICE", status: "ISSUED" }, false)).toBe("ISSUED");
    expect(INVOICE_STATUS_SLUG[CREDIT_ISSUED]).toBe("avoir-emis");
  });

  it("devis : statut de devis prioritaire, statut de document sinon", () => {
    expect(listStatus({ documentType: "QUOTE", status: "ISSUED", quoteStatus: "ACCEPTED" }, true)).toBe("ACCEPTED");
    expect(listStatus({ documentType: "QUOTE", status: "DRAFT", quoteStatus: null }, true)).toBe("DRAFT");
  });

  it("valeurs d'URL uniques par liste", () => {
    for (const slugs of [QUOTE_STATUS_SLUG, INVOICE_STATUS_SLUG]) {
      const values = Object.values(slugs);
      expect(new Set(values).size).toBe(values.length);
      expect(values).not.toContain("tous");
    }
  });
});

describe("recherche d'une liste", () => {
  const row = { number: "F-2026-0001", client: { displayName: "Atelier Recette", clientNumber: "CLI-0001" }, notes: "secret" };
  it("champs listés seulement, chemins pointés, sans casse", () => {
    expect(matchesSearch(row, ["number", "client.displayName"], "atelier")).toBe(true);
    expect(matchesSearch(row, ["number", "client.displayName"], "f-2026")).toBe(true);
    expect(matchesSearch(row, ["number", "client.displayName"], "secret")).toBe(false);
    expect(matchesSearch(row, ["number"], "  ")).toBe(true);
  });
});
