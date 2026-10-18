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
    expect(lines[0].split(";")).toHaveLength(9);
    expect(lines[2].split(";")).toHaveLength(9);
    expect(lines[2]).toContain(UNLINKED_RECEIPT_CLIENT);
  });
});

describe("type de la pièce (colonne dédiée, nature légale inchangée)", () => {
  const inv = payment().invoice!;
  it("Facture, Acompte, Solde, Abonnement, Avoir, Sans facture", () => {
    expect(buildReceiptRow(payment()).typeLabel).toBe("Facture");
    expect(buildReceiptRow(payment({ invoice: { ...inv, invoiceType: "ACOMPTE" } })).typeLabel).toBe("Acompte");
    expect(buildReceiptRow(payment({ invoice: { ...inv, invoiceType: "SOLDE" } })).typeLabel).toBe("Solde");
    expect(buildReceiptRow(payment({ invoice: { ...inv, subscriptionId: "sub_1" } })).typeLabel).toBe("Abonnement");
    expect(buildReceiptRow(payment({ invoice: { ...inv, documentType: "CREDIT_NOTE" } })).typeLabel).toBe("Avoir");
    expect(buildReceiptRow(payment({ amountCents: -5000 })).typeLabel).toBe("Avoir");
    expect(buildReceiptRow(payment({ invoice: null })).typeLabel).toBe("Sans facture");
  });

  it("CSV : colonne Type après Facture ; nature identique à celle de la ligne", () => {
    const row = buildReceiptRow(payment({ invoice: { ...inv, invoiceType: "ACOMPTE", lines: [{ description: "Acompte de 30% : Acompte - À la validation du devis" }] } }));
    const [header, line] = receiptsToCsv([row]).replace("﻿", "").split("\r\n");
    expect(header!.split(";").slice(0, 4)).toEqual(['"Date"', '"Facture"', '"Type"', '"Code client"']);
    const cells = line!.split(";");
    expect(cells[2]).toBe('"Acompte"');
    expect(cells[5]).toBe('"Acompte de 30% : Acompte - À la validation du devis"');
  });
});
