import { describe, it, expect } from "vitest";
import {
  buildReceiptRow,
  receiptsToCsv,
  UNLINKED_RECEIPT_CLIENT,
  UNLINKED_RECEIPT_NATURE,
  type ReceiptSourcePayment,
} from "@/lib/obligations/receipts.js";

function payment(overrides: Partial<ReceiptSourcePayment> = {}): ReceiptSourcePayment {
  return {
    id: "pay_1",
    paidAt: new Date("2026-08-12T10:00:00.000Z"),
    amountCents: 120000,
    method: "BANK_TRANSFER",
    reference: null,
    notes: null,
    invoice: {
      id: "inv_1",
      number: "F-2026-0004",
      notes: null,
      invoiceType: "SIMPLE",
      documentType: "INVOICE",
      totalCents: 120000,
      client: { displayName: "Studio Bertrand", clientNumber: "CLI-0007" },
      lines: [{ description: "Refonte du site" }],
    },
    ...overrides,
  };
}

describe("buildReceiptRow", () => {
  it("reprend la facture et son client quand l'encaissement est rattaché", () => {
    const row = buildReceiptRow(payment());
    expect(row.invoiceNumber).toBe("F-2026-0004");
    expect(row.clientName).toBe("Studio Bertrand");
    expect(row.clientNumber).toBe("CLI-0007");
    expect(row.nature).toBe("Refonte du site");
    expect(row.amountCents).toBe(120000);
    expect(row.invoiceTotalCents).toBe(120000);
  });

  /**
   * Un virement rapproché sans facture (POST /api/bank/transactions/:id/orphan-payment)
   * doit figurer au registre : il compte dans les recettes encaissées.
   */
  it("accepte un encaissement sans facture rattachée", () => {
    const row = buildReceiptRow(
      payment({ invoice: null, reference: "REV-8891", notes: null }),
    );
    expect(row.invoiceId).toBeNull();
    expect(row.invoiceNumber).toBeNull();
    expect(row.clientName).toBe(UNLINKED_RECEIPT_CLIENT);
    expect(row.nature).toContain(UNLINKED_RECEIPT_NATURE);
    expect(row.nature).toContain("REV-8891");
  });

  it("reprend les notes du paiement orphelin comme nature", () => {
    const row = buildReceiptRow(
      payment({ invoice: null, notes: "Acompte informel", reference: null }),
    );
    expect(row.nature).toBe("Acompte informel");
  });

  it("préfixe les avoirs et les montants négatifs", () => {
    const credit = buildReceiptRow(
      payment({
        amountCents: -50000,
        invoice: {
          ...payment().invoice!,
          documentType: "CREDIT_NOTE",
          number: "A-2026-0001",
        },
      }),
    );
    expect(credit.nature.startsWith("Avoir · ")).toBe(true);
    expect(credit.amountCents).toBe(-50000);
  });

  it("retombe sur une nature générique quand la facture n'a ni ligne ni note", () => {
    const row = buildReceiptRow(
      payment({ invoice: { ...payment().invoice!, lines: [], notes: null } }),
    );
    expect(row.nature).toBe("Prestation de services");
  });
});

describe("receiptsToCsv", () => {
  it("exporte un encaissement sans facture sans colonne vide en trop", () => {
    const csv = receiptsToCsv([
      buildReceiptRow(payment()),
      buildReceiptRow(payment({ id: "pay_2", invoice: null, reference: "REV-1" })),
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0].split(";")).toHaveLength(8);
    expect(lines[2].split(";")).toHaveLength(8);
    expect(lines[2]).toContain(UNLINKED_RECEIPT_CLIENT);
  });
});
