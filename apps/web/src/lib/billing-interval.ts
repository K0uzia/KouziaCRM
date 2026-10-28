import { formatEUR } from "@/lib/format";

/** Périodicité d'un abonnement (null en base = MONTH). QUARTER : trimestriel (mode récurrent, 24/10/2026). */
export type BillingInterval = "MONTH" | "QUARTER" | "YEAR";

/** Périodicités proposées à la création d'un abonnement ou d'une offre (le trimestriel naît d'un devis récurrent). */
export const INTERVAL_OPTIONS = [
  { id: "MONTH", label: "Mensuel" },
  { id: "YEAR", label: "Annuel" },
] as const satisfies ReadonlyArray<{ id: BillingInterval; label: string }>;

/** Révision d'un abonnement : les trois périodicités (un abonnement trimestriel garde la sienne par défaut). */
export const REVISE_INTERVAL_OPTIONS = [
  { id: "MONTH", label: "Mensuel" },
  { id: "QUARTER", label: "Trimestriel" },
  { id: "YEAR", label: "Annuel" },
] as const satisfies ReadonlyArray<{ id: BillingInterval; label: string }>;

export function normalizeInterval(value: string | null | undefined): BillingInterval {
  return value === "YEAR" || value === "QUARTER" ? value : "MONTH";
}

/** Mois couverts par une échéance (même règle que l'API, periodMonths). */
export function periodMonths(value: string | null | undefined): number {
  const iv = normalizeInterval(value);
  return iv === "YEAR" ? 12 : iv === "QUARTER" ? 3 : 1;
}

/** Mot de la période : « mois », « trimestre » ou « an ». */
export function periodWord(value: string | null | undefined): string {
  const iv = normalizeInterval(value);
  return iv === "YEAR" ? "an" : iv === "QUARTER" ? "trimestre" : "mois";
}

/** « / mois », « / trimestre » ou « / an » après un montant. */
export function periodSuffix(value: string | null | undefined): string {
  return `/ ${periodWord(value)}`;
}

/** Libellé court ajouté au nom de l'offre : « mensuel », « trimestriel » ou « annuel ». */
export function periodAdjective(value: string | null | undefined): string {
  const iv = normalizeInterval(value);
  return iv === "YEAR" ? "annuel" : iv === "QUARTER" ? "trimestriel" : "mensuel";
}

/** Équivalent mensuel d'une échéance (MRR) : montant / mois de la période (annuel : 1/12, trimestriel : 1/3). */
export function monthlyEquivalentCents(amountCents: number, value: string | null | undefined): number {
  return Math.round(amountCents / periodMonths(value));
}

/**
 * « soit 29,17 € par mois » sous un prix annuel ou trimestriel (centimes entiers, arrondi au centime le plus proche) ;
 * null pour un prix mensuel ou nul. Information de lecture : le prix dû reste celui de la période.
 */
export function monthlyEquivalentText(amountCents: number, value: string | null | undefined): string | null {
  if (normalizeInterval(value) === "MONTH" || !Number.isFinite(amountCents) || amountCents <= 0) return null;
  return `soit ${formatEUR(monthlyEquivalentCents(amountCents, value))} par mois`;
}

/** Prix saisi en euros (« 350 », « 350,5 », « 349.99 ») en centimes entiers, sans calcul en virgule flottante. */
export function eurosInputToCents(raw: string | number | null | undefined): number {
  const m = /^\s*(-)?(\d+)(?:[.,](\d{0,2}))?/.exec(String(raw ?? ""));
  if (!m) return 0;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -cents : cents;
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
  if (target === "YEAR") return from === "QUARTER" ? servicePriceCents * 4 : servicePriceCents * (12 - annualFreeMonths);
  // Vers le mois ou le trimestre : prix mensuel de la période d'origine, multiplié par les mois de la cible.
  return Math.round((servicePriceCents * periodMonths(target)) / periodMonths(from));
}
