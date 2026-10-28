/**
 * Calculs de montant purs, partagés avec l'ERP web (alias @kouzia-erp/line-amounts) : l'éditeur affiche les mêmes
 * centimes que l'API. Aucune dépendance (ni Prisma ni decimal.js), arithmétique entière exacte.
 */

/** Décimal écrit en texte (« 2.5 », « 0,25 », « 1e-3 ») : entier et nombre de décimales ; null si illisible. */
function parseDecimal(value: number | string): { digits: bigint; scale: number } | null {
  const text = String(value).trim().replace(",", ".");
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!m || (!m[2] && !m[3])) return null;
  let digits = `${m[2] ?? ""}${m[3] ?? ""}` || "0";
  let scale = (m[3] ?? "").length - Number(m[4] ?? 0);
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  return { digits: BigInt(`${m[1] ?? ""}${digits}`), scale };
}

/** Total d'une ligne en centimes : quantité × prix unitaire, arrondi au centime, demi-centime loin de zéro. */
export function lineTotalCents(quantity: number | string, unitPriceCents: number): number {
  const q = parseDecimal(quantity);
  if (!q || !Number.isInteger(unitPriceCents)) return Math.round(Number(quantity) * unitPriceCents) || 0;
  const product = q.digits * BigInt(unitPriceCents);
  if (q.scale === 0) return Number(product);
  const divisor = 10n ** BigInt(q.scale);
  const negative = product < 0n;
  const abs = negative ? -product : product;
  const rounded = (abs * 2n + divisor) / (divisor * 2n);
  return Number(negative ? -rounded : rounded);
}

export type DiscountType = "NONE" | "PERCENT" | "FIXED";

export type DiscountInput = {
  discountType?: DiscountType | string | null;
  /** PERCENT : basis points (1000 = 10 %). FIXED : centimes. */
  discountValue?: number | null;
};

/** Remise globale sur une base (la partie ponctuelle) : jamais plus que la base, aucune sur une base nulle ou négative. */
export function computeDiscountCents(subtotalCents: number, discount: DiscountInput = {}): number {
  // Base nulle ou négative (lignes à prix négatif) : aucune remise. Math.min(base, …) rendait sinon une remise négative
  // qui gonflait le total sans remise affichée (audit du 27/10/2026).
  if (subtotalCents <= 0) return 0;
  const type = (discount.discountType ?? "NONE").toUpperCase();
  const value = Math.max(0, Math.floor(Number(discount.discountValue) || 0));
  if (type === "PERCENT") {
    return Math.min(subtotalCents, Math.round((subtotalCents * value) / 10000));
  }
  if (type === "FIXED") {
    return Math.min(subtotalCents, value);
  }
  return 0;
}
