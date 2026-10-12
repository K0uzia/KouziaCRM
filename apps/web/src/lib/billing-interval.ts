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
 * Montant proposé pour une échéance à partir du prix d'une offre.
 * Offre mensuelle passée en annuel : 12 mensualités moins les mois offerts (Réglages).
 */
export function suggestedAmountCents(
  servicePriceCents: number,
  serviceInterval: string | null | undefined,
  target: BillingInterval,
  annualFreeMonths: number,
): number {
  const from = normalizeInterval(serviceInterval);
  if (from === target) return servicePriceCents;
  if (target === "YEAR") return servicePriceCents * (12 - annualFreeMonths);
  return Math.round(servicePriceCents / 12);
}
