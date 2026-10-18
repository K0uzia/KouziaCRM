import { Prisma } from "@prisma/client";
import { formatEUR as formatEURFr, formatLongDateFr } from "@/lib/format-fr.js";

// decimal.js, via Prisma : son import par défaut n'est pas typé correctement en NodeNext.
const Decimal = Prisma.Decimal;

export function eurosToCents(euros: number | string): number {
  return new Decimal(euros).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function centsToEuros(cents: number): number {
  return new Decimal(cents).div(100).toDecimalPlaces(2).toNumber();
}

/**
 * Montant en euros, format français. Intl sépare les milliers par une espace fine (U+202F),
 * absente des polices standard des PDF et de certains clients mail (rendu « 1/190,00 € ») :
 * on la remplace par l'espace insécable classique (U+00A0).
 */
export function formatEUR(cents: number): string {
  return formatEURFr(cents);
}

/** Date longue en français, « 1er » pour le premier du mois : « 1er décembre 2026 ». */
export function formatLongDate(d: Date): string {
  return formatLongDateFr(d).replace(/^1 /, "1er ");
}

export function lineTotalCents(quantity: number | string, unitPriceCents: number): number {
  return new Decimal(quantity)
    .mul(unitPriceCents)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}
