import { describe, expect, it } from "vitest";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { buildPaymentHistory } from "@/lib/portal/tracking-payload.js";

// Audit des calculs (28/10/2026) : avoirs dans l'historique des règlements de /suivi (GET /api/public/tracking, paymentHistory).
type Opts = Parameters<typeof buildPaymentHistory>[0];
type Doc = Opts["docs"][number];

const at = new Date("2026-10-10T10:00:00Z");
const doc = (d: Partial<Doc> & { id: string }) =>
  ({ number: d.id, quoteId: null, creditedInvoiceId: null, depositBaseCents: null, paymentPlanOffer: "TWO", payments: [], issueDate: at, createdAt: at, status: InvoiceStatus.ISSUED, ...d }) as unknown as Doc;

describe("/suivi : un avoir n'est pas un règlement", () => {
  // Facture d'acompte 300 € réglée, avoir de 100 € sur cette facture (totalCents d'un avoir : négatif, credit-note-service.ts:357).
  const quote = doc({ id: "D-1", documentType: InvoiceDocumentType.QUOTE, totalCents: 100_000, depositBaseCents: 100_000 });
  const deposit = doc({
    id: "F-1",
    documentType: InvoiceDocumentType.INVOICE,
    quoteId: "D-1",
    totalCents: 30_000,
    payments: [{ id: "p1", amountCents: 30_000, paidAt: at, method: "BANK_TRANSFER" }] as never,
  });
  const avoir = doc({ id: "AV-1", documentType: InvoiceDocumentType.CREDIT_NOTE, creditedInvoiceId: "F-1", totalCents: -10_000 });

  it("un avoir n'apparaît pas comme un règlement reçu (montant négatif dans l'historique)", () => {
    const h = buildPaymentHistory({ docs: [quote, deposit, avoir], milestones: [], showAmounts: true });
    const entry = h.items.find((i) => i.id === "credit-AV-1") as unknown as { amountCents: number; entryType: string; label: string };
    expect(entry.amountCents).toBe(-10_000);
    expect(entry.entryType).toBe("CREDIT_NOTE");
    expect(entry.label).toBe("Avoir émis AV-1");
  });

  it("totalPaidCents ne compte pas un avoir comme un règlement", () => {
    const h = buildPaymentHistory({ docs: [quote, deposit, avoir], milestones: [], showAmounts: true });
    expect(h.totalPaidCents).toBe(30_000);
    // Reste dû inchangé : 1 000 € - 300 € réglés - 100 € d'avoir.
    expect(h.totalDueCents).toBe(60_000);
    expect((h.items.find((i) => i.id === "payment-p1") as unknown as { entryType: string }).entryType).toBe("PAYMENT");
  });
});

