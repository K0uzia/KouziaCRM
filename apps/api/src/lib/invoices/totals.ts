import { lineTotalCents } from "@/lib/money";

export type LineInput = {
  description: string;
  quantity: number | string;
  unitPriceCents: number;
  position?: number;
  isSubscription?: boolean;
  billingDay?: number | null;
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

/** Valide les lignes abonnement avant persist. */
export function assertSubscriptionLinesValid(
  lines: Array<{
    isSubscription?: boolean;
    billingDay?: number | null;
    serviceId?: string | null;
  }>,
): void {
  for (const line of lines) {
    if (!line.isSubscription) continue;
    const day = Number(line.billingDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      throw new Error("Jour de facturation d'abonnement invalide (1–28)");
    }
    if (!line.serviceId) {
      throw new Error("Une ligne abonnement doit être liée à une prestation du catalogue");
    }
  }
}
