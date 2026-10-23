/**
 * Récapitulatif de paiement de la fenêtre devis et facture : échéancier, moyens de paiement et engagement, calculés
 * comme l'API les appliquera (lib/quotes/payment-plans.ts, lib/quotes/milestones.ts, lib/stripe/payment-methods.ts).
 * Aperçu seulement : l'API garde le dernier mot à l'émission.
 */

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

export type PlanOffer = "" | "TWO" | "THREE" | "CHOICE";
export type Installment = { label: string; percentBps: number; amountCents: number };

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

/** Montant dû sur la durée d'engagement : nombre de périodes entières dans l'engagement × prix de la période. */
export function commitmentTotalCents(periodCents: number, interval: "MONTH" | "YEAR", commitmentMonths: number): number {
  const periods = interval === "YEAR" ? Math.ceil(commitmentMonths / 12) : commitmentMonths;
  return periodCents * periods;
}
