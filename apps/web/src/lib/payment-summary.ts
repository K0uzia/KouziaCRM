/**
 * Récapitulatif de paiement de la fenêtre devis et facture : échéancier, moyens de paiement et engagement, calculés
 * comme l'API les appliquera (lib/quotes/payment-plans.ts, lib/quotes/milestones.ts, lib/stripe/payment-methods.ts).
 * Aperçu seulement : l'API garde le dernier mot à l'émission.
 */
import { monthsFromSignature, periodsWithinCommitment } from "@kouzia-erp/recurring-discount";
import { periodPriceOfAnnual } from "@kouzia-erp/annual-price";

export type PaymentSettings = {
  depositPercent1Bps: number;
  depositPercent2Bps: number;
  split3Percent1Bps: number;
  split3Percent2Bps: number;
  split3Percent3Bps: number;
  split3MinTotalCents: number;
  paymentSepaEnabled: boolean;
  paymentCardEnabled: boolean;
  paymentCardMaxCents: number;
};

export type PlanOffer = "" | "ONE" | "TWO" | "THREE" | "CHOICE";
export type Period = "MONTH" | "QUARTER" | "YEAR";

/**
 * Devis avec mode de facturation (24/10/2026), comme l'API (lib/quotes/payment-plans.ts) : parts égales arrondies au
 * centime, le reste sur la dernière ; la 1re due à la signature, puis tous les intervalDays.
 */
export function equalInstallments(plan: "ONE" | "TWO" | "THREE", totalCents: number, intervalDays: number): Installment[] {
  const n = plan === "ONE" ? 1 : plan === "TWO" ? 2 : 3;
  // Comme l'API (payment-plans.ts) : parts au centime inférieur, le reste sur la dernière.
  const part = Math.floor(totalCents / n);
  const share = Math.floor(10000 / n);
  return Array.from({ length: n }, (_, i) => ({
    label: n === 1 ? "Paiement comptant" : `${i === 0 ? "1re" : `${i + 1}e`} échéance`,
    percentBps: i === n - 1 ? 10000 - share * (n - 1) : share,
    amountCents: i === n - 1 ? totalCents - part * (n - 1) : part,
    when: i === 0 ? "à la signature" : `${i * intervalDays} jours après la signature`,
  }));
}

/**
 * Montant par période d'un prix annuel, règle unique de l'API (periodPriceOfAnnual, décision du 28/10/2026) : annuel tel
 * quel, mensuel = annuel / (12 - mois offerts), trimestriel = 3 mensualités, arrondi au centime.
 */
export function periodAmountCents(annualCents: number, period: Period, annualFreeMonths: number): number {
  return periodPriceOfAnnual(annualCents, period, annualFreeMonths);
}

/** Périodes comprises dans un engagement (36 mois au trimestre = 12). */
export function periodsIn(commitmentMonths: number, period: Period): number {
  return Math.ceil(commitmentMonths / (period === "YEAR" ? 12 : period === "QUARTER" ? 3 : 1));
}

/**
 * Échéances facturées pendant l'engagement (même règle que l'API, periodsWithinCommitment) : l'engagement court depuis
 * la signature (ici : aujourd'hui), la 1re échéance vient après les mois offerts ou à la date choisie.
 */
export function billedPeriodsIn(
  commitmentMonths: number,
  period: Period,
  start: { subscriptionStart?: string | null; subscriptionStartDate?: string | null; subscriptionFreeMonths?: string | number | null },
  signedAt: Date = new Date(),
): number {
  return periodsWithinCommitment(commitmentMonths, period, startOffsetMonths(start, signedAt)) ?? 0;
}

/** Mois de la signature (ici : aujourd'hui) à la 1re échéance : mois offerts ou date choisie, 0 sinon. */
export function startOffsetMonths(
  start: { subscriptionStart?: string | null; subscriptionStartDate?: string | null; subscriptionFreeMonths?: string | number | null },
  signedAt: Date = new Date(),
): number {
  let offset = 0;
  if (start.subscriptionStart === "FREE_MONTHS") offset = Number(start.subscriptionFreeMonths) || 0;
  if (start.subscriptionStart === "DATE" && start.subscriptionStartDate) {
    const first = new Date(`${start.subscriptionStartDate}T00:00:00`);
    if (!Number.isNaN(first.getTime()) && first > signedAt) offset = monthsFromSignature(signedAt, first);
  }
  return offset;
}

export const PERIOD_WORD: Record<Period, string> = { MONTH: "mois", QUARTER: "trimestre", YEAR: "an" };
export type Installment = { label: string; percentBps: number; amountCents: number; when?: string };

/** Jalons d'une formule : arrondi au centime, le solde reçoit le reste (computeMilestoneAmounts). */
export function installments(plan: "TWO" | "THREE", totalCents: number, s: PaymentSettings): Installment[] {
  const template =
    plan === "THREE"
      ? [
          { label: "Acompte", percentBps: s.split3Percent1Bps },
          { label: "2e acompte", percentBps: s.split3Percent2Bps },
          { label: "Solde", percentBps: s.split3Percent3Bps },
        ]
      : [
          { label: "Acompte", percentBps: s.depositPercent1Bps },
          { label: "Solde", percentBps: s.depositPercent2Bps },
        ];
  let allocated = 0;
  return template.map((m, i) => {
    const amountCents = i === template.length - 1 ? totalCents - allocated : Math.round((totalCents * m.percentBps) / 10000);
    if (i < template.length - 1) allocated += amountCents;
    return { ...m, amountCents };
  });
}

/** Formules réellement proposées : sous le seuil du 3 fois, l'offre retombe sur 2 fois à l'émission (effectiveOffer). */
/** Devis avec mode : formules proposées, le comptant compris ; seuil du 3 fois comme l'API (effectiveOffer). */
export function modePlansShown(offer: PlanOffer, totalCents: number, s: Pick<PaymentSettings, "split3MinTotalCents">): Array<"ONE" | "TWO" | "THREE"> {
  if (offer === "ONE") return ["ONE"];
  return plansShown(offer, totalCents, s);
}

export function plansShown(offer: PlanOffer, totalCents: number, s: Pick<PaymentSettings, "split3MinTotalCents">): Array<"TWO" | "THREE"> {
  if (offer === "" || offer === "TWO" || totalCents < s.split3MinTotalCents) return ["TWO"];
  return offer === "CHOICE" ? ["TWO", "THREE"] : ["THREE"];
}

/** Moyens d'un lien de paiement ponctuel, dans l'ordre proposé (paymentMethodTypes). */
export function oneOffMeans(amountCents: number, s: PaymentSettings): string[] {
  return [
    ...(s.paymentSepaEnabled ? ["prélèvement SEPA"] : []),
    "virement",
    ...(s.paymentCardEnabled && amountCents <= s.paymentCardMaxCents ? ["carte bancaire"] : []),
  ];
}

/** Moyens d'un abonnement (subscriptionMethodTypes) : jamais vide, la carte reste le dernier recours. */
export function subscriptionMeans(periodCents: number, s: PaymentSettings): string[] {
  const means = [
    ...(s.paymentSepaEnabled ? ["prélèvement SEPA"] : []),
    ...(s.paymentCardEnabled && periodCents <= s.paymentCardMaxCents ? ["carte bancaire"] : []),
  ];
  return means.length ? means : ["carte bancaire"];
}

/** « a, b ou c ». */
export function orList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ou ${items[items.length - 1]}`;
}

/** Montant dû sur la durée d'engagement : nombre de périodes dans l'engagement × prix de la période (trimestre : 3 mois). */
export function commitmentTotalCents(periodCents: number, interval: Period | null | undefined, commitmentMonths: number): number {
  return periodCents * periodsIn(commitmentMonths, interval === "YEAR" || interval === "QUARTER" ? interval : "MONTH");
}
