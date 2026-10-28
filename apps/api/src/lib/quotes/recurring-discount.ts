import type { BillingMode } from "@/lib/quotes/payment-plans.js";
import { BillingModeError, type ModeLine } from "@/lib/quotes/billing-mode.js";
import { periodMonths } from "@/lib/subscriptions/subscription-service.js";
import { longestPeriodMonths, type BillingIntervalChoice } from "@/lib/quotes/interval-choice.js";

/**
 * Remise d'un devis récurrent (R1, décisions du 25/10/2026) : une seule par devis, sur les premières échéances, puis tarif
 * plein (rachat, annuités restantes et reconduction aussi au tarif plein). PERCENT en points de base, FIXED en centimes
 * par échéance ; durée en mois depuis la 1re échéance (multiple de la période), null = toute la durée de l'engagement.
 * Remise d'ouverture (case, décision d'Alexandre du 19/10/2026) : 30 % sur 12 mois, engagement de 36 mois seulement,
 * sans cumul avec une remise volontaire.
 */
import { NO_RECURRING_DISCOUNT, OPENING_DISCOUNT, type RecurringDiscountFields, type RecurringDiscountInput } from "@/lib/quotes/recurring-discount-calc.js";
export * from "@/lib/quotes/recurring-discount-calc.js";

type SubLine = ModeLine & { unitPriceCents: number };

/** Montant d'une échéance au tarif plein : somme des lignes d'abonnement (une seule période par devis récurrent). */
const periodAmountOf = (lines: ReadonlyArray<SubLine>) => lines.filter((l) => l.isSubscription).reduce((s, l) => s + l.unitPriceCents, 0);

/** Champs à enregistrer sur le devis ; BillingModeError (message pour l'écran) si la remise n'est pas permise. */
export function resolveRecurringDiscount(
  mode: BillingMode | null,
  lines: ReadonlyArray<SubLine>,
  input: RecurringDiscountInput,
  /** Rythmes au choix du client (28/10/2026) : durée multiple de chaque période, pas de montant fixe par échéance. */
  offered: ReadonlyArray<BillingIntervalChoice> = [],
): RecurringDiscountFields {
  const manual = input.recurringDiscount ?? null;
  if (!manual && !input.openingDiscount) return NO_RECURRING_DISCOUNT;
  if (mode !== "RECURRING") throw new BillingModeError("Remise sur les échéances : réservée au devis en paiement récurrent.");
  if (manual && input.openingDiscount) {
    throw new BillingModeError("Remise d'ouverture et remise volontaire ne se cumulent pas : choisissez l'une ou l'autre.");
  }
  const first = lines.find((l) => l.isSubscription);
  const commitment = first?.commitmentMonths ?? null;
  if (input.openingDiscount) {
    if (commitment !== OPENING_DISCOUNT.commitmentMonths) {
      throw new BillingModeError("Remise d'ouverture : seulement avec l'engagement de 36 mois. Choisissez 36 mois, ou retirez la remise d'ouverture.");
    }
    return { recurringDiscountKind: "PERCENT", recurringDiscountValue: OPENING_DISCOUNT.value, recurringDiscountMonths: OPENING_DISCOUNT.months, openingDiscount: true };
  }
  const m = manual!;
  const amount = periodAmountOf(lines);
  let value: number;
  if (m.kind === "PERCENT") {
    value = Math.round((m.percent ?? 0) * 100);
    if (!(value > 0 && value < 10000)) throw new BillingModeError("Remise : un pourcentage entre 0 et 100 % (exclus).");
  } else {
    if (offered.length > 1) {
      throw new BillingModeError("Remise en montant par échéance : un seul rythme de paiement. Proposez un pourcentage, ou un seul rythme.");
    }
    value = Math.round((m.euros ?? 0) * 100);
    if (!(value > 0 && value < amount)) throw new BillingModeError("Remise : un montant positif, inférieur au prix d'une échéance.");
  }
  const months = m.months ?? null;
  if (months !== null) {
    const step = offered.length > 1 ? longestPeriodMonths(offered) : periodMonths(first?.billingInterval);
    if (!Number.isInteger(months) || months < step || months % step !== 0) {
      throw new BillingModeError(`Remise : une durée en mois, multiple de ${step} (la période de paiement).`);
    }
    if (commitment && months > commitment) throw new BillingModeError("Remise : la durée ne dépasse pas l'engagement.");
  }
  return { recurringDiscountKind: m.kind, recurringDiscountValue: value, recurringDiscountMonths: months, openingDiscount: false };
}

/** Remise volontaire enregistrée sur un brouillon, sous la forme saisie (la remise d'ouverture est la case). */
export function storedRecurringDiscount(row: {
  recurringDiscountKind: string | null;
  recurringDiscountValue: number | null;
  recurringDiscountMonths: number | null;
  openingDiscount: boolean;
}): RecurringDiscountInput["recurringDiscount"] {
  if (row.openingDiscount || !row.recurringDiscountKind || !row.recurringDiscountValue) return null;
  return row.recurringDiscountKind === "PERCENT"
    ? { kind: "PERCENT", percent: row.recurringDiscountValue / 100, months: row.recurringDiscountMonths }
    : { kind: "FIXED", euros: row.recurringDiscountValue / 100, months: row.recurringDiscountMonths };
}
