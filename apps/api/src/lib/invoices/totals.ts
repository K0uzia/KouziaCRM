import { lineTotalCents } from "@/lib/money.js";

export type LineInput = {
  description: string;
  quantity: number | string;
  unitPriceCents: number;
  position?: number;
  isSubscription?: boolean;
  billingDay?: number | null;
  /** MONTH | YEAR ; null ou absent = MONTH */
  billingInterval?: string | null;
  serviceId?: string | null;
  subscriptionId?: string | null;
};

export type DiscountType = "NONE" | "PERCENT" | "FIXED";

export type DiscountInput = {
  discountType?: DiscountType | string | null;
  /** PERCENT : basis points (1000 = 10 %). FIXED : centimes. */
  discountValue?: number | null;
};

export function computeDiscountCents(
  subtotalCents: number,
  discount: DiscountInput = {},
): number {
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

export function computeLineTotals(lines: LineInput[], discount: DiscountInput = {}) {
  const computed = lines.map((line, index) => {
    const isSubscription = Boolean(line.isSubscription);
    const qty = isSubscription ? 1 : Number(line.quantity);
    const total = lineTotalCents(qty, line.unitPriceCents);
    const billingDay = isSubscription ? Number(line.billingDay) : null;
    return {
      position: line.position ?? index + 1,
      description: line.description.trim(),
      quantity: qty,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: total,
      isSubscription,
      billingDay:
        isSubscription && Number.isInteger(billingDay) && billingDay! >= 1 && billingDay! <= 28
          ? billingDay
          : null,
      billingInterval: isSubscription && line.billingInterval === "YEAR" ? "YEAR" : null,
      serviceId: isSubscription ? line.serviceId || null : null,
      subscriptionId: line.subscriptionId ?? null,
    };
  });

  const subtotalCents = computed.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const discountCents = computeDiscountCents(subtotalCents, discount);
  const discountType =
    discountCents > 0
      ? ((discount.discountType ?? "NONE").toUpperCase() as DiscountType)
      : "NONE";
  const discountValue = discountCents > 0 ? Math.max(0, Math.floor(Number(discount.discountValue) || 0)) : 0;

  return {
    lines: computed,
    subtotalCents,
    discountCents,
    discountType: discountCents > 0 ? discountType : "NONE",
    discountValue,
    totalCents: subtotalCents - discountCents,
  };
}

/**
 * Base de l'acompte et de l'échéancier d'un devis : la partie ponctuelle (lignes hors abonnement),
 * remise répartie au prorata. L'abonnement n'y entre pas : il est facturé à chaque période.
 */
export function computeDepositBaseCents(
  lines: ReadonlyArray<{ isSubscription: boolean; lineTotalCents: number }>,
  subtotalCents: number,
  totalCents: number,
): number {
  const oneOff = lines.filter((l) => !l.isSubscription).reduce((s, l) => s + l.lineTotalCents, 0);
  if (subtotalCents <= 0 || oneOff <= 0) return 0;
  const discount = Math.max(0, subtotalCents - totalCents);
  return Math.max(0, oneOff - Math.round((discount * oneOff) / subtotalCents));
}

/** Base d'un devis : figée à l'émission ; devis antérieur à la fonction (null) : son total. */
export function depositBaseOf(quote: { depositBaseCents: number | null; totalCents: number }): number {
  return quote.depositBaseCents ?? quote.totalCents;
}

/** Valide les lignes abonnement avant persist. */
export function assertSubscriptionLinesValid(
  lines: Array<{
    isSubscription?: boolean;
    billingDay?: number | null;
    serviceId?: string | null;
    billingInterval?: string | null;
  }>,
): void {
  // Un seul abonnement par client : les lignes d'abonnement d'un document en forment un seul.
  const intervals = new Set(lines.filter((l) => l.isSubscription).map((l) => (l.billingInterval === "YEAR" ? "YEAR" : "MONTH")));
  if (intervals.size > 1) {
    throw new Error("Les lignes d'abonnement d'un même document doivent avoir la même périodicité (toutes mensuelles ou toutes annuelles).");
  }
  for (const line of lines) {
    if (!line.isSubscription) continue;
    const day = Number(line.billingDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      throw new Error("Jour de facturation d'abonnement invalide (1 à 28)");
    }
    if (!line.serviceId) {
      throw new Error("Une ligne abonnement doit être liée à une prestation du catalogue");
    }
  }
}
