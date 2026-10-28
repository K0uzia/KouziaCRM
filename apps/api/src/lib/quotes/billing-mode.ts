import type { BillingMode } from "@/lib/quotes/payment-plans.js";
import { isCommitmentMonths } from "@/lib/subscriptions/commitment.js";

/** Ligne vue par les règles du mode : champs d'abonnement tels qu'enregistrés. */
export type ModeLine = {
  isSubscription: boolean;
  /** Abonnement annuel en option, au choix du client à la signature (paiement unique seulement). */
  isOptional?: boolean | null;
  billingInterval?: string | null;
  billingDay?: number | null;
  commitmentMonths?: number | null;
  subscriptionStart?: string | null;
  subscriptionStartDate?: Date | string | null;
  subscriptionFreeMonths?: number | null;
};

export class BillingModeError extends Error {}

/**
 * Montant par période d'un prix annuel (24/10/2026) : annuel tel quel, / 4 au trimestre, / 12 au mois, arrondi au
 * centime, sans majoration ni remise. L'écart d'arrondi sur l'année (2 900 € / 12 = 241,67 €) est affiché tel quel.
 */
export function periodAmountCents(annualCents: number, interval: string | null | undefined): number {
  if (interval === "YEAR") return annualCents;
  return Math.round(annualCents / (interval === "QUARTER" ? 4 : 12));
}

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/**
 * Ligne en option (28/10/2026) : abonnement annuel avec engagement de 12, 24 ou 36 mois, qui démarre à la livraison et
 * dont l'engagement court depuis ce départ. Proposé seulement sur un devis en paiement unique.
 */
function assertOptionalLine(l: ModeLine): void {
  if (!l.isSubscription || l.billingInterval !== "YEAR") {
    throw new BillingModeError("Option : seul un abonnement annuel peut être proposé en option.");
  }
  if (!isCommitmentMonths(l.commitmentMonths)) throw new BillingModeError("Option : choisissez un engagement de 12, 24 ou 36 mois.");
  if (l.subscriptionStart !== "DELIVERY") throw new BillingModeError("Option : l'abonnement démarre à la livraison.");
}

/**
 * Règles d'un devis avec mode (24/10/2026). ONE_OFF : au moins une ligne ponctuelle ; un abonnement n'y entre qu'en
 * option, au choix du client (28/10/2026). RECURRING : au moins une ligne
 * d'abonnement, toutes avec la même période, le même engagement, le même départ et le même jour de prélèvement (le
 * mode est choisi une fois pour le document). Aucune ligne ponctuelle (décision du 23/10/2026) : le prix annuel comprend
 * toute la prestation, sans frais de mise en service.
 */
export function assertBillingModeLines(mode: BillingMode | null, lines: ReadonlyArray<ModeLine>): void {
  if (mode !== "ONE_OFF" && lines.some((l) => l.isOptional)) {
    throw new BillingModeError("Une option au choix du client n'est possible que sur un devis en paiement unique.");
  }
  if (!mode) return;
  const subs = lines.filter((l) => l.isSubscription);
  if (mode === "ONE_OFF") {
    lines.filter((l) => l.isOptional).forEach(assertOptionalLine);
    if (subs.some((l) => !l.isOptional)) {
      throw new BillingModeError("Paiement unique : un abonnement n'y entre qu'en option, au choix du client. Mettez-le en option, ou passez le devis en paiement récurrent.");
    }
    if (!lines.some((l) => !l.isSubscription && !l.isOptional)) {
      throw new BillingModeError("Paiement unique : le devis doit comporter au moins une ligne ponctuelle en plus de l'option.");
    }
    return;
  }
  if (subs.length === 0) throw new BillingModeError("Paiement récurrent : le devis doit comporter au moins une ligne d'abonnement.");
  if (subs.length < lines.length) {
    throw new BillingModeError(
      "Paiement récurrent : le prix annuel comprend toute la prestation, sans frais de mise en service. Retirez les lignes ponctuelles, ou passez le devis en paiement unique.",
    );
  }
  // Décision du 23/10/2026 : pas d'abonnement sans engagement, 12 mois au minimum ; le mois et le trimestre ne sont
  // qu'une façon de payer l'engagement.
  if (subs.some((l) => !isCommitmentMonths(l.commitmentMonths))) {
    throw new BillingModeError("Paiement récurrent : choisissez un engagement de 12, 24 ou 36 mois.");
  }
  const key = (l: ModeLine) =>
    [l.billingInterval ?? "MONTH", l.commitmentMonths ?? "", l.subscriptionStart ?? "", day(l.subscriptionStartDate), l.subscriptionFreeMonths ?? "", l.billingDay ?? ""].join("|");
  if (new Set(subs.map(key)).size > 1) {
    throw new BillingModeError("Paiement récurrent : période, engagement, départ et jour de prélèvement sont les mêmes pour tout le devis.");
  }
}
