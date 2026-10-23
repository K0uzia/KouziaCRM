import type { BillingMode } from "@/lib/quotes/payment-plans.js";
import { isCommitmentMonths } from "@/lib/subscriptions/commitment.js";

/** Ligne vue par les règles du mode : champs d'abonnement tels qu'enregistrés. */
export type ModeLine = {
  isSubscription: boolean;
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
 * Règles d'un devis avec mode (24/10/2026). ONE_OFF : aucune ligne d'abonnement. RECURRING : au moins une ligne
 * d'abonnement, toutes avec la même période, le même engagement, le même départ et le même jour de prélèvement (le
 * mode est choisi une fois pour le document). Aucune ligne ponctuelle (décision du 23/10/2026) : le prix annuel comprend
 * toute la prestation, sans frais de mise en service.
 */
export function assertBillingModeLines(mode: BillingMode | null, lines: ReadonlyArray<ModeLine>): void {
  if (!mode) return;
  const subs = lines.filter((l) => l.isSubscription);
  if (mode === "ONE_OFF") {
    if (subs.length > 0) throw new BillingModeError("Paiement unique : retirez les lignes d'abonnement, ou passez le devis en paiement récurrent.");
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
