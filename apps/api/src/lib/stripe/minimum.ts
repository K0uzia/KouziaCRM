import { formatEUR } from "@/lib/money.js";
import {
  describePlans,
  effectiveOffer,
  parsePaymentPlanOffer,
  type PlanSettings,
} from "@/lib/quotes/payment-plans.js";

/** Montant minimal d'un paiement en ligne Stripe en euros (Checkout le refuse en dessous). */
export const ONLINE_MIN_CENTS = 50;

export function belowOnlineMinimum(cents: number): boolean {
  return cents > 0 && cents < ONLINE_MIN_CENTS;
}

/** Message de la page de paiement : montant trop faible pour le paiement en ligne. */
export function onlineMinimumMessage(contactEmail: string | null | undefined): string {
  const contact = contactEmail?.trim() ? ` à ${contactEmail.trim()}` : "";
  return `Montant inférieur au minimum accepté par le paiement en ligne (${formatEUR(ONLINE_MIN_CENTS)}) : réglez par virement ou contactez-nous${contact}.`;
}

/**
 * Avertissement (non bloquant) à l'émission d'un devis : échéances payables en ligne sous le
 * minimum Stripe. null si aucune.
 */
export function quoteOnlineMinimumWarning(
  offerRaw: string | null,
  totalCents: number,
  settings: PlanSettings,
): string | null {
  const offer = effectiveOffer(parsePaymentPlanOffer(offerRaw), totalCents, settings);
  const small = describePlans(offer, totalCents, settings).flatMap((p) =>
    p.milestones
      .filter((m) => belowOnlineMinimum(m.amountCents))
      .map((m) => `${m.label} de ${formatEUR(m.amountCents)} (${p.plan === "THREE" ? "3 fois" : "2 fois"})`),
  );
  if (small.length === 0) return null;
  return `Paiement en ligne impossible sous ${formatEUR(ONLINE_MIN_CENTS)} : ${small.join(", ")}. Le client devra régler ${small.length > 1 ? "ces échéances" : "cette échéance"} par virement.`;
}
