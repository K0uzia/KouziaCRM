import { describe, expect, it } from "vitest";
import { InvoiceDocumentType, MilestoneStatus } from "@prisma/client";
import { buildPaymentHistory } from "@/lib/portal/tracking-payload.js";

type Opts = Parameters<typeof buildPaymentHistory>[0];
type Doc = Opts["docs"][number];
type Milestone = Opts["milestones"][number];

// Cas relevé en recette : devis 1 €, acompte 30 % payé par virement (paiement manuel).
// Le jalon et le règlement de la facture d'acompte sont horodatés à quelques ms d'écart.
const paidAtMilestone = new Date("2026-10-10T16:12:00.123Z");
const paidAtPayment = new Date("2026-10-10T16:12:00.131Z");

const quote = {
  id: "q1",
  number: "D-2026-0001",
  documentType: InvoiceDocumentType.QUOTE,
  totalCents: 100,
  payments: [],
} as unknown as Doc;

const depositInvoice = {
  id: "f1",
  number: "F-2026-0001",
  documentType: InvoiceDocumentType.INVOICE,
  totalCents: 30,
  payments: [{ id: "p1", amountCents: 30, paidAt: paidAtPayment, method: "BANK_TRANSFER" }],
} as unknown as Doc;

const milestones = [
  {
    id: "m1",
    label: "Acompte",
    status: MilestoneStatus.PAID,
    amountCents: 30,
    paidAt: paidAtMilestone,
    paymentMethod: "BANK_TRANSFER",
    quote: { number: "D-2026-0001" },
    generatedInvoice: { id: "f1", number: "F-2026-0001" },
  },
  {
    id: "m2",
    label: "Solde",
    status: MilestoneStatus.PENDING,
    amountCents: 70,
    paidAt: null,
    paymentMethod: null,
    quote: { number: "D-2026-0001" },
    generatedInvoice: null,
  },
] as unknown as Milestone[];

describe("historique des paiements du portail", () => {
  it("un acompte payé n'est compté qu'une fois, même si les horodatages diffèrent", () => {
    const h = buildPaymentHistory({ docs: [depositInvoice, quote], milestones, showAmounts: true });
    expect(h.items).toHaveLength(1);
    expect(h.totalPaidCents).toBe(30);
    // Reste dû du contrat : totalNetDueCents (routes/public.ts), totalDueCents retiré le 28/10/2026.
    expect("totalDueCents" in h).toBe(false);
  });

  it("règlement d'une facture hors jalon : compté normalement", () => {
    const free = {
      id: "f2",
      number: "F-2026-0002",
      documentType: InvoiceDocumentType.INVOICE,
      totalCents: 50,
      payments: [{ id: "p2", amountCents: 50, paidAt: paidAtPayment, method: "CARD" }],
    } as unknown as Doc;
    const h = buildPaymentHistory({ docs: [depositInvoice, free, quote], milestones, showAmounts: true });
    expect(h.items).toHaveLength(2);
    expect(h.totalPaidCents).toBe(80);
  });

  it("facture d'un jalon pas encore marqué payé : ses règlements restent visibles", () => {
    const pending = milestones.map((m) => (m.id === "m1" ? { ...m, status: MilestoneStatus.INVOICED, paidAt: null } : m));
    const h = buildPaymentHistory({ docs: [depositInvoice, quote], milestones: pending, showAmounts: true });
    expect(h.items).toHaveLength(1);
    expect(h.items[0]).toMatchObject({ label: "Règlement F-2026-0001" });
    expect(h.totalPaidCents).toBe(30);
  });
});
