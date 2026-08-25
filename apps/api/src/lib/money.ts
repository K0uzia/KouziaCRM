import Decimal from "decimal.js";

export function eurosToCents(euros: number | string): number {
  return new Decimal(euros).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function centsToEuros(cents: number): number {
  return new Decimal(cents).div(100).toDecimalPlaces(2).toNumber();
}

export function formatEUR(cents: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(centsToEuros(cents));
}

export function lineTotalCents(quantity: number | string, unitPriceCents: number): number {
  return new Decimal(quantity)
    .mul(unitPriceCents)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}
