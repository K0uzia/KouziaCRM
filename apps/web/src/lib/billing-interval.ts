import { annualPriceOfService } from "@kouzia-erp/annual-price";
import { formatEUR } from "@/lib/format";

/** Périodicité d'un abonnement (null en base = MONTH). */
export type BillingInterval = "MONTH" | "YEAR";

export const INTERVAL_OPTIONS = [
  { id: "MONTH", label: "Mensuel" },
  { id: "YEAR", label: "Annuel" },
] as const satisfies ReadonlyArray<{ id: BillingInterval; label: string }>;

export function normalizeInterval(value: string | null | undefined): BillingInterval {
  return value === "YEAR" ? "YEAR" : "MONTH";
}

/** « / mois » ou « / an » après un montant. */
export function periodSuffix(value: string | null | undefined): string {
  return normalizeInterval(value) === "YEAR" ? "/ an" : "/ mois";
}

/** Libellé court ajouté au nom de l'offre : « mensuel » ou « annuel ». */
export function periodAdjective(value: string | null | undefined): string {
  return normalizeInterval(value) === "YEAR" ? "annuel" : "mensuel";
}

/** Équivalent mensuel d'une échéance : un montant annuel compte pour 1/12. */
export function monthlyEquivalentCents(amountCents: number, value: string | null | undefined): number {
  return normalizeInterval(value) === "YEAR" ? Math.round(amountCents / 12) : amountCents;
}

/**
 * « soit 29,17 € par mois » sous un prix annuel (centimes entiers, arrondi au centime le plus proche) ; null pour
 * un prix mensuel ou nul. Information de lecture : le prix dû reste l'annuel.
 */
export function monthlyEquivalentText(amountCents: number, value: string | null | undefined): string | null {
  if (normalizeInterval(value) !== "YEAR" || !Number.isFinite(amountCents) || amountCents <= 0) return null;
  return `soit ${formatEUR(monthlyEquivalentCents(amountCents, "YEAR"))} par mois`;
}

/** Prix saisi en euros (« 350 », « 350,5 », « 349.99 ») en centimes entiers, sans calcul en virgule flottante. */
export function eurosInputToCents(raw: string | number | null | undefined): number {
  const m = /^\s*(-)?(\d+)(?:[.,](\d{0,2}))?/.exec(String(raw ?? ""));
  if (!m) return 0;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

/**
 * Montant proposé pour une échéance à partir du prix d'une offre. Passage en annuel : règle unique de l'API
 * (annualPriceOfService) : prix annuel du catalogue s'il existe, sinon 12 mensualités moins les mois offerts (Réglages).
 */
export function suggestedAmountCents(
  servicePriceCents: number,
  serviceInterval: string | null | undefined,
  target: BillingInterval,
  annualFreeMonths: number,
  annualPriceCents?: number | null,
): number {
  const from = normalizeInterval(serviceInterval);
  if (from === target) return servicePriceCents;
  if (target === "YEAR") return annualPriceOfService({ unitPriceCents: servicePriceCents, billingInterval: serviceInterval, annualPriceCents }, annualFreeMonths);
  return Math.round(servicePriceCents / 12);
}
