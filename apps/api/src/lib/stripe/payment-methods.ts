import type { CompanySettings } from "@prisma/client";

/**
 * Moyens proposés sur un lien Stripe (décisions du 19/10/2026), dans cet ordre :
 * 1. prélèvement SEPA (0,35 € par paiement réussi, grille Stripe France) ;
 * 2. virement par l'IBAN virtuel Stripe, paiement ponctuel seulement (0,5 %, plafonné à 5 €), pour le rapprochement ;
 * 3. carte jusqu'au seuil des réglages (1,5 % + 0,25 € pour une carte standard de l'EEE).
 * Le virement direct sur l'IBAN de la facture reste toujours possible, hors Stripe.
 */
export type PaymentMethodSettings = Pick<CompanySettings, "paymentSepaEnabled" | "paymentCardEnabled" | "paymentCardMaxCents">;
export type StripeMethod = "sepa_debit" | "customer_balance" | "card";

export function cardAllowed(amountCents: number, s: PaymentMethodSettings): boolean {
  return s.paymentCardEnabled && amountCents <= s.paymentCardMaxCents;
}

/** Paiement ponctuel (facture, échéance) : jamais vide, le virement Stripe est toujours proposé. */
export function paymentMethodTypes(amountCents: number, s: PaymentMethodSettings): StripeMethod[] {
  return [
    ...(s.paymentSepaEnabled ? (["sepa_debit"] as const) : []),
    "customer_balance",
    ...(cardAllowed(amountCents, s) ? (["card"] as const) : []),
  ];
}

/**
 * Abonnement (mandat à la 1re mise en place) : SEPA, et carte sous le seuil (montant d'une échéance). Le virement
 * Stripe n'existe pas pour un abonnement ; si rien n'est permis par les réglages, la carte reste le seul moyen.
 */
export function subscriptionMethodTypes(amountCents: number, s: PaymentMethodSettings): Array<"sepa_debit" | "card"> {
  const types: Array<"sepa_debit" | "card"> = [
    ...(s.paymentSepaEnabled ? (["sepa_debit"] as const) : []),
    ...(cardAllowed(amountCents, s) ? (["card"] as const) : []),
  ];
  return types.length ? types : ["card"];
}

/** Phrase de l'e-mail de mise en place du prélèvement, selon les moyens proposés. */
export function subscriptionMethodsSentence(types: Array<"sepa_debit" | "card">): string {
  if (types.length > 1) return "Vous pourrez choisir un prélèvement SEPA ou une carte bancaire.";
  return types[0] === "card" ? "Le paiement se fait par carte bancaire." : "Le paiement se fait par prélèvement SEPA : munissez-vous de votre IBAN.";
}

/** Indication pour /suivi et les e-mails : moyen principal d'un lien Stripe de ce montant. */
export function primaryMethod(amountCents: number, s: PaymentMethodSettings): "sepa_debit" | "card" | "bank_transfer" {
  if (s.paymentSepaEnabled) return "sepa_debit";
  return cardAllowed(amountCents, s) ? "card" : "bank_transfer";
}
