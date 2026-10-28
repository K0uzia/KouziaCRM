/**
 * Rythme de paiement au choix du client (décisions d'Alexandre du 28/10/2026). Sur un devis récurrent, Alexandre coche les
 * rythmes proposés (annuel, trimestriel, mensuel) ; le client en retient un à la signature. Le devis porte alors le prix
 * annuel (lignes d'abonnement en YEAR) ; chaque échéance en découle par periodPriceOfAnnual, ligne par ligne, et
 * l'engagement et la remise sont recomptés au rythme retenu (periodsWithinCommitment, recurringDiscountSummary).
 * Calcul pur, sans import hors des modules purs : partagé avec l'éditeur (alias @kouzia-erp/interval-choice).
 */
import { periodPriceOfAnnual } from "../services/annual-price.js";
import { periodsWithinCommitment, recurringDiscountSummary, type RecurringDiscountSummary } from "./recurring-discount-calc.js";

export type BillingIntervalChoice = "YEAR" | "QUARTER" | "MONTH";
/** Ordre d'affichage : du rythme le moins cher au plus souple. */
export const INTERVAL_ORDER: readonly BillingIntervalChoice[] = ["YEAR", "QUARTER", "MONTH"];
export const INTERVAL_LABEL: Record<BillingIntervalChoice, string> = { YEAR: "Annuel", QUARTER: "Trimestriel", MONTH: "Mensuel" };

const isInterval = (v: unknown): v is BillingIntervalChoice => v === "YEAR" || v === "QUARTER" || v === "MONTH";

/** Rythmes enregistrés (« YEAR,MONTH »), dans l'ordre d'affichage, sans doublon ni valeur inconnue. */
export function parseOfferedIntervals(value: string | ReadonlyArray<string> | null | undefined): BillingIntervalChoice[] {
  const raw = typeof value === "string" ? value.split(",") : (value ?? []);
  const set = new Set(raw.map((v) => v.trim()).filter(isInterval));
  return INTERVAL_ORDER.filter((iv) => set.has(iv));
}

/** Valeur à enregistrer : null pour un seul rythme (ou aucun), le comportement d'avant. */
export function offeredIntervalsValue(list: ReadonlyArray<string> | null | undefined): string | null {
  const parsed = parseOfferedIntervals(list ?? []);
  return parsed.length > 1 ? parsed.join(",") : null;
}

/** Choix proposé au client : deux rythmes au moins. */
export const hasIntervalChoice = (value: string | null | undefined): boolean => parseOfferedIntervals(value).length > 1;

/** Mois d'une échéance du rythme le plus long proposé (pas de durée de remise : multiple de chaque période). */
export function longestPeriodMonths(list: ReadonlyArray<BillingIntervalChoice>): number {
  return list.includes("YEAR") ? 12 : list.includes("QUARTER") ? 3 : 1;
}

/**
 * Rythme envoyé à la signature : obligatoire quand plusieurs sont proposés, l'un d'eux ; sans choix, absent ou égal au
 * rythme des lignes. Toutes sources (espace client, hors ligne, messagerie) : jamais de choix par défaut.
 */
export function intervalChoiceError(
  offered: ReadonlyArray<BillingIntervalChoice>,
  chosen: string | null | undefined,
  linesInterval?: string | null,
): "REQUIRED" | "INVALID" | null {
  if (offered.length > 1) {
    if (!chosen) return "REQUIRED";
    return isInterval(chosen) && offered.includes(chosen) ? null : "INVALID";
  }
  if (!chosen) return null;
  return chosen === (linesInterval === "YEAR" || linesInterval === "QUARTER" ? linesInterval : "MONTH") ? null : "INVALID";
}

/** Messages des erreurs de choix du rythme (espace client, hors ligne, messagerie). */
export const INTERVAL_CHOICE_MESSAGES = {
  REQUIRED: "Choisissez le rythme de paiement de l'abonnement.",
  INVALID: "Ce rythme de paiement n'est pas proposé sur ce devis.",
} as const;

export type IntervalChoiceRow = {
  interval: BillingIntervalChoice;
  /** Montant d'une échéance au tarif plein : somme des lignes, chacune convertie puis arrondie (comme à la signature). */
  amountCents: number;
  /** Échéances facturées pendant l'engagement ; null sans engagement. */
  periods: number | null;
  /** Total sur l'engagement, remise comprise ; null sans engagement. */
  totalCommitmentCents: number | null;
  discount: RecurringDiscountSummary | null;
};

/**
 * Une ligne par rythme proposé (tableau du PDF et de /suivi avant la signature) : prix par échéance et total sur
 * l'engagement, remise recomptée au rythme. annualLineCents : prix annuel de chaque ligne d'abonnement.
 */
export function intervalChoiceRows(input: {
  offered: ReadonlyArray<BillingIntervalChoice>;
  annualLineCents: ReadonlyArray<number>;
  annualFreeMonths: number;
  commitmentMonths: number | null;
  /** Mois de la signature à la 1re échéance (monthsFromSignature) : mois offerts, 1re facture à une date. */
  offsetMonths?: number;
  discount: Parameters<typeof recurringDiscountSummary>[0];
}): IntervalChoiceRow[] {
  return input.offered.map((interval) => {
    const amountCents = input.annualLineCents.reduce((s, c) => s + periodPriceOfAnnual(c, interval, input.annualFreeMonths), 0);
    const periods = periodsWithinCommitment(input.commitmentMonths, interval, input.offsetMonths ?? 0);
    const discount = recurringDiscountSummary(input.discount, amountCents, interval, input.commitmentMonths, periods);
    return {
      interval,
      amountCents,
      periods,
      totalCommitmentCents: discount?.totalCommitmentCents ?? (periods === null ? null : amountCents * periods),
      discount,
    };
  });
}

/**
 * Phrase de la remise quand le rythme reste à choisir : le taux et sa durée, sans montant (il dépend du rythme) ; les
 * totaux du tableau la comprennent.
 */
export function choiceDiscountSentence(d: Pick<RecurringDiscountSummary, "kind" | "value" | "months" | "opening" | "promoCode">): string {
  const what = d.kind === "PERCENT" ? `${String(d.value / 100).replace(".", ",")} %` : "remise par échéance";
  const head = `${d.promoCode ? `Code promo ${d.promoCode}` : d.opening ? "Remise d’ouverture" : "Remise"} : ${what}`;
  const span = d.months == null ? "sur toute la durée de l’engagement" : `sur les ${d.months} premiers mois`;
  return `${head} ${span}, quel que soit le rythme, comprise dans les totaux sur l’engagement.`;
}
