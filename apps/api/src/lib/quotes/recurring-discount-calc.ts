/**
 * Calcul pur de la remise d'un devis récurrent (R1) : aucun import, partagé avec le front (alias
 * @kouzia-erp/recurring-discount). Les règles d'enregistrement sont dans recurring-discount.ts.
 */

const periodMonths = (interval: string | null | undefined) => (interval === "YEAR" ? 12 : interval === "QUARTER" ? 3 : 1);

export type RecurringDiscountKind = "PERCENT" | "FIXED";
export type RecurringDiscountFields = {
  recurringDiscountKind: RecurringDiscountKind | null;
  recurringDiscountValue: number | null;
  recurringDiscountMonths: number | null;
  openingDiscount: boolean;
};
export type RecurringDiscountInput = {
  recurringDiscount?: { kind: RecurringDiscountKind; percent?: number; euros?: number; months?: number | null } | null;
  openingDiscount?: boolean;
};

export const OPENING_DISCOUNT = { kind: "PERCENT" as const, value: 3000, months: 12, commitmentMonths: 36 };
export const NO_RECURRING_DISCOUNT: RecurringDiscountFields = {
  recurringDiscountKind: null,
  recurringDiscountValue: null,
  recurringDiscountMonths: null,
  openingDiscount: false,
};

/** Remise d'une échéance (centimes), jamais plus que l'échéance. */
export function discountCentsPerPeriod(kind: string | null | undefined, value: number | null | undefined, amountCents: number): number {
  if (!value || value <= 0) return 0;
  if (kind === "PERCENT") return Math.min(amountCents, Math.round((amountCents * value) / 10000));
  if (kind === "FIXED") return Math.min(amountCents, value);
  return 0;
}

/**
 * Échéances facturées pendant l'engagement (décision du 28/10/2026) : l'engagement court depuis la signature, la 1re
 * échéance peut venir plus tard (mois offerts, 1re facture à une date). Seules les échéances qui tombent avant la fin
 * de l'engagement comptent (12 mois dont 3 offerts : 9 échéances). Même calcul pour le PDF, /suivi et l'activation.
 * offsetMonths : mois de la signature à la 1re échéance (monthsFromSignature). null sans engagement.
 */
export function periodsWithinCommitment(commitmentMonths: number | null | undefined, interval: string | null | undefined, offsetMonths = 0): number | null {
  if (!commitmentMonths) return null;
  return Math.max(0, Math.ceil((commitmentMonths - Math.max(0, offsetMonths)) / periodMonths(interval)));
}

/**
 * Mois de la signature à la 1re échéance, au jour près (l'heure ne compte pas) : jour plus tardif dans le mois, une
 * demi-unité de plus ; plus tôt, une demi-unité de moins. Le décompte des échéances (entiers) n'en dépend pas autrement.
 */
export function monthsFromSignature(signedAt: Date, firstInvoiceAt: Date): number {
  const whole = (firstInvoiceAt.getFullYear() - signedAt.getFullYear()) * 12 + firstInvoiceAt.getMonth() - signedAt.getMonth();
  const a = signedAt.getDate();
  const b = firstInvoiceAt.getDate();
  return b === a ? whole : whole + (b > a ? 0.5 : -0.5);
}

/** Nombre d'échéances remisées : durée de la remise (ou de l'engagement) / mois de la période. */
export function discountedPeriods(months: number | null | undefined, commitmentMonths: number | null | undefined, interval: string | null | undefined): number {
  const span = months ?? commitmentMonths ?? 0;
  return span > 0 ? Math.ceil(span / periodMonths(interval)) : 0;
}

/** Résumé d'un devis récurrent remisé (PDF, version lisible, /suivi) ; null sans remise. */
export function recurringDiscountSummary(
  fields: {
    recurringDiscountKind: string | null;
    recurringDiscountValue: number | null;
    recurringDiscountMonths: number | null;
    openingDiscount: boolean;
    /** Code promo appliqué (R3) : « Code promo X » à la place de « Remise », condition imprimée. */
    promoCode?: { code: string; conditionText: string | null } | null;
  },
  amountCents: number,
  interval: string | null | undefined,
  commitmentMonths: number | null | undefined,
  /**
   * Échéances facturées pendant l'engagement (periodsWithinCommitment) ; absent : toute la durée, sans mois offerts.
   * Une remise « sur toute la durée de l'engagement » ne dépasse jamais la fin de l'engagement.
   */
  billedPeriods?: number | null,
) {
  const perPeriod = discountCentsPerPeriod(fields.recurringDiscountKind, fields.recurringDiscountValue, amountCents);
  if (!perPeriod) return null;
  const totalPeriods = billedPeriods ?? periodsWithinCommitment(commitmentMonths, interval);
  const periods = Math.min(discountedPeriods(fields.recurringDiscountMonths, commitmentMonths, interval), totalPeriods ?? Infinity);
  return {
    kind: fields.recurringDiscountKind as RecurringDiscountKind,
    value: fields.recurringDiscountValue!,
    months: fields.recurringDiscountMonths,
    opening: fields.openingDiscount,
    promoCode: fields.promoCode?.code ?? null,
    condition: fields.promoCode?.conditionText?.trim() || null,
    periods,
    discountCentsPerPeriod: perPeriod,
    discountedAmountCents: amountCents - perPeriod,
    totalCommitmentCents: totalPeriods === null ? null : amountCents * totalPeriods - perPeriod * periods,
  };
}

export type RecurringDiscountSummary = NonNullable<ReturnType<typeof recurringDiscountSummary>>;

const PERIOD_WORD: Record<string, string> = { YEAR: "an", QUARTER: "trimestre", MONTH: "mois" };

/**
 * Phrase de la remise, mot pour mot dans le PDF, la version lisible, le formulaire et /suivi (retouche du 26/10/2026) :
 * « … sur la 1re échéance, soit 1 050,00 € la 1re année, puis 1 500,00 € par an. » (annuel, une échéance) ;
 * « … sur les N premières échéances, soit X € par mois pendant M mois, puis Y € par mois. » ;
 * « … sur toute la durée de l’engagement, soit X € par mois. ».
 */
export function discountSentence(
  d: RecurringDiscountSummary,
  periodCents: number,
  interval: string | null | undefined,
  euros: (cents: number) => string,
): string {
  const word = PERIOD_WORD[interval ?? "MONTH"] ?? "mois";
  const what = d.kind === "PERCENT" ? `${String(d.value / 100).replace(".", ",")} %` : `${euros(d.value)} par échéance`;
  const head = `${d.promoCode ? `Code promo ${d.promoCode}` : d.opening ? "Remise d’ouverture" : "Remise"} : ${what}`;
  if (d.months == null) return `${head} sur toute la durée de l’engagement, soit ${euros(d.discountedAmountCents)} par ${word}.`;
  const span = d.periods === 1 ? "sur la 1re échéance" : `sur les ${d.periods} premières échéances`;
  if (interval === "YEAR" && d.periods === 1) {
    return `${head} ${span}, soit ${euros(d.discountedAmountCents)} la 1re année, puis ${euros(periodCents)} par an.`;
  }
  return `${head} ${span}, soit ${euros(d.discountedAmountCents)} par ${word} pendant ${d.months} mois, puis ${euros(periodCents)} par ${word}.`;
}

/** Montant de la prochaine échéance d'un abonnement : remise déduite tant qu'il reste des échéances remisées. */
export function nextPeriodAmountCents(sub: {
  amountCents: number;
  discountKind: string | null;
  discountValue: number | null;
  discountPeriods: number | null;
  discountPeriodsBilled: number;
}): number {
  const remaining = sub.discountPeriods ? sub.discountPeriods - sub.discountPeriodsBilled : 0;
  return remaining > 0 ? sub.amountCents - discountCentsPerPeriod(sub.discountKind, sub.discountValue, sub.amountCents) : sub.amountCents;
}
