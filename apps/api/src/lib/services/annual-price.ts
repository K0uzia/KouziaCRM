/**
 * Prix annuel d'un abonnement du catalogue (audit du 28/10/2026), une seule règle partagée avec l'ERP web (alias
 * @kouzia-erp/annual-price) : le prix annuel du catalogue s'il est renseigné ; sinon un prix annuel tel quel, et un prix
 * mensuel ou trimestriel ramené à 12 mois moins les mois offerts des réglages (annualFreeMonths).
 */
export function annualPriceOfService(
  svc: { unitPriceCents: number; billingInterval?: string | null; annualPriceCents?: number | null },
  annualFreeMonths: number,
): number {
  if (svc.annualPriceCents != null) return svc.annualPriceCents;
  if (svc.billingInterval === "YEAR") return svc.unitPriceCents;
  const paidMonths = 12 - Math.min(12, Math.max(0, annualFreeMonths));
  const monthsPerPeriod = svc.billingInterval === "QUARTER" ? 3 : 1;
  return Math.round((svc.unitPriceCents * paidMonths) / monthsPerPeriod);
}
