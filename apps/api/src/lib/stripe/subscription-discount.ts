import type Stripe from "stripe";

/**
 * Remise d'un abonnement prélevé par Stripe (R2, 26/10/2026). Stripe compte la durée d'un coupon depuis son application
 * (la mise en place du prélèvement), pas depuis la 1re échéance, qui peut être repoussée. L'ERP fait donc foi : chaque
 * facture Stripe remisée est comptée (discountPeriodsBilled) et, la dernière échéance remisée atteinte, la remise est
 * retirée de l'abonnement Stripe. La durée du coupon (repeating, jamais forever) n'est qu'un garde-fou, un peu large :
 * elle couvre toutes les échéances remisées même si la 1re est repoussée.
 */
export type DiscountedSubscription = {
  id: string;
  discountKind: string | null;
  discountValue: number | null;
  discountPeriods: number | null;
  discountPeriodsBilled: number;
  billingInterval: string | null;
  nextInvoiceAt: Date;
};

const DAY_MS = 86_400_000;
const periodMonths = (interval: string | null) => (interval === "YEAR" ? 12 : interval === "QUARTER" ? 3 : 1);

export function remainingDiscountPeriods(sub: Pick<DiscountedSubscription, "discountKind" | "discountValue" | "discountPeriods" | "discountPeriodsBilled">): number {
  if (!sub.discountKind || !sub.discountValue || !sub.discountPeriods) return 0;
  return Math.max(0, sub.discountPeriods - sub.discountPeriodsBilled);
}

/** Paramètres du coupon ; null sans remise restante. L'identifiant décrit la remise : une remise différente, un autre coupon. */
export function couponParams(sub: DiscountedSubscription, now = new Date()): Stripe.CouponCreateParams & { id: string } | null {
  const remaining = remainingDiscountPeriods(sub);
  if (!remaining) return null;
  const gapMonths = Math.max(0, Math.ceil((sub.nextInvoiceAt.getTime() - now.getTime()) / (30 * DAY_MS)));
  const months = gapMonths + remaining * periodMonths(sub.billingInterval);
  const percent = sub.discountKind === "PERCENT";
  return {
    id: `kouzia-${sub.id}-${remaining}x-${percent ? `p${sub.discountValue}` : `f${sub.discountValue}`}`,
    name: percent ? `Remise de ${String(sub.discountValue! / 100).replace(".", ",")} %` : "Remise",
    duration: "repeating",
    duration_in_months: months,
    ...(percent ? { percent_off: sub.discountValue! / 100 } : { amount_off: sub.discountValue!, currency: "eur" }),
    metadata: { erpSubscriptionId: sub.id },
  };
}

/** Coupon Stripe de la remise restante, créé s'il n'existe pas ; null sans remise. */
export async function ensureSubscriptionCoupon(stripe: Stripe, sub: DiscountedSubscription, now = new Date()): Promise<string | null> {
  const params = couponParams(sub, now);
  if (!params) return null;
  try {
    return (await stripe.coupons.retrieve(params.id)).id;
  } catch (err) {
    if ((err as { code?: string }).code !== "resource_missing") throw err;
    return (await stripe.coupons.create(params)).id;
  }
}

/** Remise d'une facture Stripe (centimes) : somme des remises appliquées. */
export function stripeInvoiceDiscountCents(invoice: Stripe.Invoice): number {
  return (invoice.total_discount_amounts ?? []).reduce((sum, d) => sum + (d.amount ?? 0), 0);
}
