import { annualFreeMonthsOf } from "@/lib/quotes/payment-plans.js";
import { intervalChoiceRows, parseOfferedIntervals, type BillingIntervalChoice, type IntervalChoiceRow } from "@/lib/quotes/interval-choice.js";
import { monthsFromSignature } from "@/lib/quotes/recurring-discount-calc.js";
import { lineFirstInvoiceAt, quoteSignedAtOf, type StartLine } from "@/lib/subscriptions/start.js";

type OfferDoc = {
  offeredIntervals?: string | null;
  paymentScheduleSnapshot?: string | null;
  recurringDiscountKind: string | null;
  recurringDiscountValue: number | null;
  recurringDiscountMonths: number | null;
  openingDiscount: boolean;
  promoCode?: { code: string; conditionText: string | null } | null;
  quoteDecidedAt?: Date | null;
  issueDate?: Date | null;
};
type OfferLine = StartLine & { isSubscription: boolean; unitPriceCents: number; commitmentMonths: number | null; billingDay: number | null };

export type QuoteIntervalOffer = { offered: BillingIntervalChoice[]; annualFreeMonths: number; rows: IntervalChoiceRow[] };

/**
 * Rythmes au choix d'un devis récurrent (28/10/2026), une seule lecture pour le PDF, /suivi et la signature : lignes
 * d'abonnement au prix annuel, mois offerts figés à l'émission, engagement depuis la signature (avant : l'émission),
 * 1re échéance décalée par les mois offerts ou la date choisie. null sans choix (un seul rythme).
 */
export function quoteIntervalOffer(doc: OfferDoc, lines: ReadonlyArray<OfferLine>, settings: { annualFreeMonths: number }): QuoteIntervalOffer | null {
  const offered = parseOfferedIntervals(doc.offeredIntervals);
  const subs = lines.filter((l) => l.isSubscription);
  const first = subs[0];
  if (offered.length < 2 || !first) return null;
  const annualFreeMonths = annualFreeMonthsOf(doc, settings);
  const signedAt = quoteSignedAtOf(doc);
  const firstInvoiceAt = lineFirstInvoiceAt(first, first.billingDay ?? 1, signedAt);
  return {
    offered,
    annualFreeMonths,
    rows: intervalChoiceRows({
      offered,
      annualLineCents: subs.map((l) => l.unitPriceCents),
      annualFreeMonths,
      commitmentMonths: first.commitmentMonths,
      offsetMonths: firstInvoiceAt ? monthsFromSignature(signedAt, firstInvoiceAt) : 0,
      discount: doc,
    }),
  };
}
