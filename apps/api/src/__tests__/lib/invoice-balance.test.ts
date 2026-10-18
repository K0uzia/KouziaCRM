import { describe, expect, it } from "vitest";
import { InvoiceStatus } from "@prisma/client";
import { creditNoteCaps, invoiceBalance, settledStatus } from "@/lib/invoices/balance.js";

const pay = (...amounts: number[]) => amounts.map((amountCents) => ({ amountCents }));

describe("reste dû d'une facture, avoirs compris", () => {
  it("exemple chiffré : facture 1 000, avoir 300 en déduction, puis paiement 700", () => {
    const facture = { totalCents: 100_000, payments: pay(), creditNotes: [] as Array<{ totalCents: number; payments: { amountCents: number }[] }> };
    let b = invoiceBalance(facture);
    expect(b).toMatchObject({ netCents: 100_000, cashInCents: 0, dueCents: 100_000 });
    expect(settledStatus(InvoiceStatus.ISSUED, b)).toBe(InvoiceStatus.ISSUED);
    expect(creditNoteCaps(b)).toEqual({ deductCents: 100_000, refundCents: 0, maxCents: 100_000 });

    facture.creditNotes.push({ totalCents: -30_000, payments: [] });
    b = invoiceBalance(facture);
    expect(b).toMatchObject({ creditedCents: 30_000, netCents: 70_000, cashInCents: 0, dueCents: 70_000 });
    expect(settledStatus(InvoiceStatus.ISSUED, b)).toBe(InvoiceStatus.ISSUED);

    facture.payments = pay(70_000);
    b = invoiceBalance(facture);
    expect(b).toMatchObject({ netCents: 70_000, cashInCents: 70_000, dueCents: 0 });
    expect(settledStatus(InvoiceStatus.ISSUED, b)).toBe(InvoiceStatus.PAID);
  });

  it("remboursement : facture 1 000 payée, puis avoir 300 remboursé par virement", () => {
    const b = invoiceBalance({ totalCents: 100_000, payments: pay(100_000), creditNotes: [{ totalCents: -30_000, payments: pay(-30_000) }] });
    expect(b).toEqual({ totalCents: 100_000, creditedCents: 30_000, netCents: 70_000, paidCents: 100_000, refundedCents: 30_000, cashInCents: 70_000, dueCents: 0 });
    expect(settledStatus(InvoiceStatus.PAID, b)).toBe(InvoiceStatus.PAID);
  });

  it("avoir sans remboursement sur une facture déjà payée : un trop-perçu, jamais un reste dû négatif", () => {
    const b = invoiceBalance({ totalCents: 100_000, payments: pay(100_000), creditNotes: [{ totalCents: -30_000, payments: [] }] });
    expect(b).toMatchObject({ netCents: 70_000, cashInCents: 100_000, dueCents: 0 });
    expect(creditNoteCaps(b)).toEqual({ deductCents: 0, refundCents: 70_000, maxCents: 70_000 });
  });

  it("avoirs couvrant tout le total : annulée, payée ou non", () => {
    expect(settledStatus(InvoiceStatus.ISSUED, invoiceBalance({ totalCents: 50_000, payments: [], creditNotes: [{ totalCents: -50_000 }] }))).toBe(InvoiceStatus.CANCELLED);
    expect(
      settledStatus(InvoiceStatus.PAID, invoiceBalance({ totalCents: 50_000, payments: pay(50_000), creditNotes: [{ totalCents: -50_000, payments: pay(-50_000) }] })),
    ).toBe(InvoiceStatus.CANCELLED);
  });

  it("paiement partiel : plafonds de l'avoir séparés (déduction sur le reste, remboursement de l'encaissé)", () => {
    const b = invoiceBalance({ totalCents: 100_000, payments: pay(40_000), creditNotes: [] });
    expect(b.dueCents).toBe(60_000);
    expect(creditNoteCaps(b)).toEqual({ deductCents: 60_000, refundCents: 40_000, maxCents: 100_000 });
  });

  it("brouillon et facture annulée gardent leur statut", () => {
    const b = invoiceBalance({ totalCents: 10_000, payments: [] });
    expect(settledStatus(InvoiceStatus.DRAFT, b)).toBe(InvoiceStatus.DRAFT);
    expect(settledStatus(InvoiceStatus.CANCELLED, b)).toBe(InvoiceStatus.CANCELLED);
  });
});

describe("promotion du statut et trop-perçu", () => {
  it("une facture Payée n'est jamais rendue « Émise » ; trop-perçu = encaissé au-delà du net", async () => {
    const { promotedStatus, overpaidCents } = await import("@/lib/invoices/balance.js");
    const partial = invoiceBalance({ totalCents: 100_000, payments: pay(40_000) });
    expect(promotedStatus(InvoiceStatus.PAID, partial)).toBe(InvoiceStatus.PAID);
    expect(promotedStatus(InvoiceStatus.ISSUED, partial)).toBe(InvoiceStatus.ISSUED);
    const over = invoiceBalance({ totalCents: 100_000, payments: pay(100_000), creditNotes: [{ totalCents: -30_000, payments: [] }] });
    expect(overpaidCents(over)).toBe(30_000);
    expect(overpaidCents(partial)).toBe(0);
  });
});
