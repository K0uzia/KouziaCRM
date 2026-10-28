import { describe, expect, it } from "vitest";
import { periodsWithinCommitment, recurringDiscountSummary } from "@/lib/quotes/recurring-discount-calc.js";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import { lineFirstInvoiceAt, linePeriodsWithinCommitment } from "@/lib/subscriptions/start.js";
import { commitmentEndOf } from "@/lib/subscriptions/commitment.js";
import { nextPeriodDate, periodMonths } from "@/lib/subscriptions/subscription-service.js";

/**
 * Audit du 28/10/2026 (décision d'Alexandre) : l'engagement court depuis la signature ; avec des mois offerts ou une 1re
 * facture plus tardive, le total sur l'engagement ne compte que les échéances réellement facturées pendant
 * l'engagement (12 mois dont 3 offerts : 9 échéances, 900 €), et une remise « sur toute la durée de l'engagement » ne
 * dépasse pas sa fin. Une seule règle pour le PDF, /suivi et l'activation (linePeriodsWithinCommitment).
 */

/** Échéances réellement émises avant la fin de l'engagement, au jour près (comme le cycle de facturation). */
function billedWithinCommitment(firstInvoiceAt: Date, signedAt: Date, months: number, interval: string) {
  const end = commitmentEndOf(signedAt, months);
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  let n = 0;
  for (let at = firstInvoiceAt; at < endDay; at = nextPeriodDate(at, periodMonths(interval), firstInvoiceAt.getDate())) n += 1;
  return n;
}

const noDiscount = { recurringDiscountKind: null, recurringDiscountValue: null, recurringDiscountMonths: null, openingDiscount: false };
const line = (over: Record<string, unknown>) => ({
  subscriptionStart: null,
  subscriptionStartDate: null,
  subscriptionFreeMonths: null,
  billingInterval: "MONTH",
  commitmentMonths: 12,
  billingDay: 1,
  ...over,
});

describe("échéances facturées pendant l'engagement", () => {
  const signedAt = new Date(2026, 10, 1, 10, 0, 0); // 1er novembre 2026, 10 h

  it("3 mois offerts, 100 €/mois, engagement 12 mois : 9 échéances, 900 €", () => {
    const l = line({ subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 3 });
    const first = lineFirstInvoiceAt(l, 1, signedAt)!;
    // 1re échéance le 1er février 2027 : trois mois offerts, pas quatre (l'heure de la signature ne compte pas).
    expect(first.getMonth()).toBe(1);
    const billed = billedWithinCommitment(first, signedAt, 12, "MONTH");
    expect(billed).toBe(9);
    expect(linePeriodsWithinCommitment(l, signedAt)).toBe(9);
  });

  it("1re facture le 1er mars 2027, 300 €/trimestre, engagement 12 mois : 3 échéances", () => {
    const l = line({ subscriptionStart: "DATE", subscriptionStartDate: new Date(2027, 2, 1), billingInterval: "QUARTER" });
    const first = lineFirstInvoiceAt(l, 1, signedAt)!;
    expect(billedWithinCommitment(first, signedAt, 12, "QUARTER")).toBe(3);
    expect(linePeriodsWithinCommitment(l, signedAt)).toBe(3);
  });

  it("signé le 15, jour de prélèvement le 1er, 3 mois offerts : même décompte que le cycle réel", () => {
    const signed = new Date(2026, 10, 15, 9, 0);
    const l = line({ subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 3 });
    const first = lineFirstInvoiceAt(l, 1, signed)!;
    expect(linePeriodsWithinCommitment(l, signed)).toBe(billedWithinCommitment(first, signed, 12, "MONTH"));
  });

  it("sans départ particulier : toutes les échéances de l'engagement", () => {
    expect(linePeriodsWithinCommitment(line({}), signedAt)).toBe(12);
    expect(linePeriodsWithinCommitment(line({ billingInterval: "QUARTER", commitmentMonths: 24 }), signedAt)).toBe(8);
    expect(linePeriodsWithinCommitment(line({ billingInterval: "YEAR", commitmentMonths: 36 }), signedAt)).toBe(3);
    expect(periodsWithinCommitment(null, "MONTH")).toBeNull();
  });

  it("remise « sur toute la durée de l'engagement » + 3 mois offerts : 9 échéances remisées, pas 12", () => {
    const s = recurringDiscountSummary({ ...noDiscount, recurringDiscountKind: "PERCENT", recurringDiscountValue: 2000 }, 10_000, "MONTH", 12, 9)!;
    expect(s.periods).toBe(9);
    expect(s.totalCommitmentCents).toBe(9 * 8_000);
  });

  it("total sur l'engagement = somme des échéances facturées (remise comprise)", () => {
    for (const [interval, commitment, months] of [["MONTH", 12, 3], ["QUARTER", 24, 6], ["YEAR", 36, 12], ["MONTH", 36, null]] as const) {
      const s = recurringDiscountSummary({ ...noDiscount, recurringDiscountKind: "PERCENT", recurringDiscountValue: 3000, recurringDiscountMonths: months }, 24167, interval, commitment)!;
      const periods = commitment / periodMonths(interval);
      let sum = 0;
      for (let k = 0; k < periods; k++) sum += 24167 - (k < s.periods ? s.discountCentsPerPeriod : 0);
      expect(s.totalCommitmentCents).toBe(sum);
    }
  });
});

/** Devis minimal pour le payload PDF (champs lus par buildInvoicePdfPayload). */
function quoteRecord(over: Record<string, unknown>, lines: Array<Record<string, unknown>>) {
  const base = {
    id: "q1",
    number: "D-2026-001",
    documentType: "QUOTE",
    invoiceType: "SIMPLE",
    status: "ISSUED",
    quoteStatus: "SENT",
    issueDate: new Date("2026-11-01T10:00:00"),
    dueDate: null,
    validUntil: null,
    serviceDate: null,
    purchaseOrderRef: null,
    paymentTerms: null,
    notes: null,
    discountType: "NONE",
    discountValue: 0,
    marketTotalCents: null,
    refundMethod: null,
    paymentPlan: null,
    paymentPlanOffer: "TWO",
    billingMode: null,
    recurringDiscountKind: null,
    recurringDiscountValue: null,
    recurringDiscountMonths: null,
    openingDiscount: false,
    paymentScheduleSnapshot: null,
    scopeSnapshot: null,
    buysOutSubscriptionId: null,
    selectedOptionId: null,
    quoteSignerName: null,
    quoteDecidedAt: null,
    milestones: [],
    payments: [],
    options: [],
    ...over,
  };
  const full = lines.map((l, i) => ({
    id: `l${i}`,
    position: i + 1,
    quantity: 1,
    isSubscription: false,
    billingDay: null,
    billingInterval: null,
    groupTitle: null,
    isPackDiscount: false,
    isOptional: false,
    optionalAccepted: null,
    optionId: null,
    commitmentMonths: null,
    subscriptionStart: null,
    subscriptionStartDate: null,
    subscriptionFreeMonths: null,
    serviceId: "s",
    lineTotalCents: l.unitPriceCents,
    ...l,
  }));
  return { ...base, lines: full } as never;
}

describe("PDF : blocs de totaux d'abonnement", () => {
  it("devis mixte : un abonnement trimestriel n'est pas additionné aux abonnements mensuels", () => {
    const payload = buildInvoicePdfPayload({
      clientType: "B2B",
      invoice: quoteRecord({ subtotalCents: 115000, totalCents: 115000, depositBaseCents: 100000 }, [
        { description: "Site", unitPriceCents: 100000 },
        { description: "Maintenance", unitPriceCents: 12000, isSubscription: true, billingInterval: "QUARTER", billingDay: 1, subscriptionStart: "DELIVERY", commitmentMonths: 12 },
        { description: "Hébergement", unitPriceCents: 3000, isSubscription: true, billingInterval: "MONTH", billingDay: 1, subscriptionStart: "DELIVERY", commitmentMonths: 12 },
      ]),
    });
    expect(payload.mixedTotals!.monthCents).toBe(3000);
    expect(payload.mixedTotals!.quarterCents).toBe(12000);
  });

  it("devis récurrent avec 3 mois offerts : « Total sur la durée de l'engagement » = 9 échéances, 900 €", () => {
    const sub = { description: "Offre", unitPriceCents: 10000, isSubscription: true, billingInterval: "MONTH", billingDay: 1, commitmentMonths: 12, subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 3 };
    const payload = buildInvoicePdfPayload({
      clientType: "B2B",
      invoice: quoteRecord({ billingMode: "RECURRING", paymentPlanOffer: "NONE", subtotalCents: 0, totalCents: 0, depositBaseCents: 0 }, [sub]),
    });
    expect(payload.recurringSummary!.periods).toBe(9);
    expect(payload.recurringSummary!.totalCommitmentCents).toBe(90000);
  });
});
