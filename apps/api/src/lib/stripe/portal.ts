import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { assertStripeEnabled, getStripe } from "@/lib/stripe/client.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";
import { StripeCheckoutError } from "@/lib/stripe/checkout.js";

/**
 * Lien à mettre dans un e-mail pour régler, changer de moyen de paiement ou résilier : lien ERP
 * permanent vers le portail Stripe pour un abonnement déjà prélevé, sinon lien de mise en place.
 */
export function subscriptionPaymentUrl(sub: { id: string; stripeSubscriptionId: string | null }): string {
  return buildPayUrl(sub.stripeSubscriptionId ? "manage" : "subscribe", sub.id);
}

/** Lien permanent vers le changement de carte dans le portail Stripe (carte qui expire). */
export function subscriptionCardUpdateUrl(sub: { id: string }): string {
  return buildPayUrl("card", sub.id);
}

function customerIdOf(stripeSub: Stripe.Subscription): string {
  return typeof stripeSub.customer === "string" ? stripeSub.customer : stripeSub.customer.id;
}

/**
 * Destination Stripe calculée au clic (les sessions de portail expirent vite, le lien ERP non) :
 * - échéance ouverte que Stripe ne retentera pas : page de paiement de cette facture ;
 * - paiement en retard ou impayé : portail, directement sur le changement de moyen de paiement ;
 * - sinon : accueil du portail (moyen de paiement, factures, résiliation).
 * `updateCard` (carte qui expire) : toujours le changement de moyen de paiement.
 */
export async function createSubscriptionPortalUrl(
  subscriptionId: string,
  opts: { updateCard?: boolean } = {},
): Promise<string> {
  await assertStripeEnabled();
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub?.stripeSubscriptionId) throw new StripeCheckoutError("Abonnement sans prélèvement Stripe", 404);

  const stripe = await getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId, { expand: ["latest_invoice"] });
  const latest = stripeSub.latest_invoice;
  if (
    !opts.updateCard &&
    latest &&
    typeof latest !== "string" &&
    latest.status === "open" &&
    !latest.next_payment_attempt &&
    latest.hosted_invoice_url
  ) {
    return latest.hosted_invoice_url;
  }

  const late = opts.updateCard || stripeSub.status === "past_due" || stripeSub.status === "unpaid";
  const session = await stripe.billingPortal.sessions.create({
    customer: customerIdOf(stripeSub),
    return_url: await resolveClientPortalUrl(),
    ...(late ? { flow_data: { type: "payment_method_update" as const } } : {}),
  });
  return session.url;
}
