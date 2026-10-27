import { randomBytes } from "node:crypto";
import type Stripe from "stripe";
import { SubscriptionStatus } from "@prisma/client";
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

/** Abonnement visé par un jeton court ; null si inconnu ou abonnement clôturé (audit du 27/10/2026). */
export async function subscriptionIdFromShortToken(token: string): Promise<string | null> {
  if (!SHORT_TOKEN.test(token)) return null;
  const sub = await prisma.subscription.findUnique({ where: { publicToken: token }, select: { id: true, status: true } });
  return sub && sub.status !== SubscriptionStatus.ENDED ? sub.id : null;
}

/**
 * Renouvelle les liens courts des abonnements d'un client (accès compromis : « Déconnecter tous ses appareils ») :
 * les anciens liens d'e-mail ne servent plus, le prochain e-mail porte un nouveau jeton.
 */
export async function rotateSubscriptionTokens(clientId: string): Promise<number> {
  const { count } = await prisma.subscription.updateMany({ where: { clientId, publicToken: { not: null } }, data: { publicToken: null } });
  return count;
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

/** Repère de la configuration de portail créée par l'ERP pour les abonnements engagés. */
export const NO_CANCEL_PORTAL_METADATA = { kouzia_erp: "abonnement-engage" } as const;
let noCancelConfigId: string | null = null;

/**
 * Configuration du portail sans résiliation (décision du 23/10/2026) : moyen de paiement et factures seulement.
 * La configuration par défaut du compte Stripe se règle dans le tableau de bord et peut permettre la résiliation :
 * elle n'est jamais utilisée pour un abonnement engagé. Retrouvée par sa métadonnée, créée au premier besoin.
 */
export async function noCancelPortalConfiguration(stripe: Stripe): Promise<string> {
  if (noCancelConfigId) return noCancelConfigId;
  const existing = await stripe.billingPortal.configurations.list({ active: true, limit: 100 });
  const found = existing.data.find(
    (c) => c.metadata?.kouzia_erp === NO_CANCEL_PORTAL_METADATA.kouzia_erp && !c.features.subscription_cancel.enabled,
  );
  const config =
    found ??
    (await stripe.billingPortal.configurations.create(
      {
        name: "ERP Kouzia : abonnement engagé",
        metadata: { ...NO_CANCEL_PORTAL_METADATA },
        features: {
          payment_method_update: { enabled: true },
          invoice_history: { enabled: true },
          subscription_cancel: { enabled: false },
          subscription_update: { enabled: false },
          customer_update: { enabled: false },
        },
      },
      { idempotencyKey: "kouzia-portal-config-abonnement-engage-v1" },
    ));
  noCancelConfigId = config.id;
  return config.id;
}

/** Tests : oublie la configuration retenue. */
export function resetNoCancelPortalConfiguration() {
  noCancelConfigId = null;
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
    // Abonnement engagé : portail sans résiliation ni changement d'offre (la résiliation se demande depuis /suivi).
    ...(sub.commitmentEndsAt ? { configuration: await noCancelPortalConfiguration(stripe) } : {}),
    ...(late ? { flow_data: { type: "payment_method_update" as const } } : {}),
  };
  // Lien rouvert le même jour (client ou analyse de messagerie) : même session de portail.
  const session = await stripe.billingPortal.sessions.create(params, { idempotencyKey: dailyIdempotencyKey("portal", params) });
  return session.url;
}
