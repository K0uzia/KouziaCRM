import { randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { assertStripeEnabled, getStripe } from "@/lib/stripe/client.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";
import { publicApiBaseUrl } from "@/lib/settings/public.js";
import { StripeCheckoutError } from "@/lib/stripe/checkout.js";
import { dailyIdempotencyKey } from "@/lib/stripe/idempotency.js";

/** Jeton court des liens d'e-mail : 16 octets aléatoires, 22 caractères base64url. */
export const SHORT_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** Jeton court de l'abonnement, créé au premier lien envoyé (aléatoire, pas dérivé de l'identifiant). */
async function publicTokenOf(subscriptionId: string): Promise<string> {
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, select: { publicToken: true } });
  if (sub.publicToken) return sub.publicToken;
  const token = randomBytes(16).toString("base64url");
  // Deux envois simultanés : le premier jeton écrit est gardé.
  await prisma.subscription.updateMany({ where: { id: subscriptionId, publicToken: null }, data: { publicToken: token } });
  return (await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } })).publicToken!;
}

/** Abonnement visé par un jeton court ; null si inconnu. */
export async function subscriptionIdFromShortToken(token: string): Promise<string | null> {
  if (!SHORT_TOKEN.test(token)) return null;
  const sub = await prisma.subscription.findUnique({ where: { publicToken: token }, select: { id: true } });
  return sub?.id ?? null;
}

/**
 * Lien à mettre dans un e-mail pour régler, changer de moyen de paiement ou résilier : lien ERP
 * permanent et court vers le portail Stripe pour un abonnement déjà prélevé, sinon lien de mise en place.
 */
export async function subscriptionPaymentUrl(sub: { id: string; stripeSubscriptionId: string | null }): Promise<string> {
  if (!sub.stripeSubscriptionId) return buildPayUrl("subscribe", sub.id);
  return `${publicApiBaseUrl()}/api/public/manage/${await publicTokenOf(sub.id)}`;
}

/** Lien permanent et court vers le changement de carte dans le portail Stripe (carte qui expire). */
export async function subscriptionCardUpdateUrl(sub: { id: string }): Promise<string> {
  return `${publicApiBaseUrl()}/api/public/card/${await publicTokenOf(sub.id)}`;
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
  const params: Stripe.BillingPortal.SessionCreateParams = {
    customer: customerIdOf(stripeSub),
    return_url: await resolveClientPortalUrl(),
    ...(late ? { flow_data: { type: "payment_method_update" as const } } : {}),
  };
  // Lien rouvert le même jour (client ou analyse de messagerie) : même session de portail.
  const session = await stripe.billingPortal.sessions.create(params, { idempotencyKey: dailyIdempotencyKey("portal", params) });
  return session.url;
}
