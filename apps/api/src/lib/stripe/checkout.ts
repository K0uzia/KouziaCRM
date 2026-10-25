import { BALANCE_INCLUDE, invoiceBalance } from "@/lib/invoices/balance.js";
import { ensureSubscriptionCoupon } from "@/lib/stripe/subscription-discount.js";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  MilestoneStatus,
  QuoteStatus,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { normalizeInterval } from "@/lib/subscriptions/subscription-service.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { assertStripeEnabled, getStripe } from "@/lib/stripe/client.js";
import { ensureStripeCustomer } from "@/lib/stripe/customers.js";
import { keyLivemode } from "@/lib/stripe/mode.js";
import { getCompanySettings } from "@/lib/company.js";
import { paymentMethodTypes, subscriptionMethodTypes } from "@/lib/stripe/payment-methods.js";
import { dailyIdempotencyKey } from "@/lib/stripe/idempotency.js";
import { PROCESSING_NOTICE } from "@/lib/stripe/pay-page.js";
import type Stripe from "stripe";

export class StripeCheckoutError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Session Checkout créée de façon idempotente sur la journée : un lien rouvert rend la même session. */
function createCheckoutSession(stripe: Stripe, params: Stripe.Checkout.SessionCreateParams) {
  return stripe.checkout.sessions.create(params, { idempotencyKey: dailyIdempotencyKey("checkout", params) });
}

async function portalRedirect(): Promise<{ success: string; cancel: string }> {
  const portal = await resolveClientPortalUrl();
  return { success: portal, cancel: portal };
}

/** Session Checkout ponctuelle pour une facture : SEPA, virement Stripe, carte sous le seuil (lib/stripe/payment-methods). */
export async function createInvoiceCheckoutSession(invoiceId: string): Promise<string> {
  await assertStripeEnabled();
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { ...BALANCE_INCLUDE, client: true },
  });
  if (!invoice || invoice.documentType !== InvoiceDocumentType.INVOICE) {
    throw new StripeCheckoutError("Facture introuvable", 404);
  }
  if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.CANCELLED) {
    throw new StripeCheckoutError("Cette facture est déjà réglée ou annulée", 409);
  }
  if (invoice.paymentProcessingAt) throw new StripeCheckoutError(PROCESSING_NOTICE, 409);

  // Montant du lien : le reste dû, avoirs compris.
  const remaining = invoiceBalance(invoice).dueCents;
  if (remaining <= 0) {
    throw new StripeCheckoutError("Cette facture est déjà soldée", 409);
  }

  const stripe = await getStripe();
  const customerId = await ensureStripeCustomer(invoice.clientId);
  const redirects = await portalRedirect();
  const label = invoice.number
    ? `Facture ${invoice.number}`
    : `Facture ${invoice.id.slice(0, 8)}`;

  const session = await createCheckoutSession(stripe, {
    mode: "payment",
    customer: customerId,
    allowed_payment_method_types: paymentMethodTypes(remaining, await getCompanySettings()),
    payment_method_options: {
      customer_balance: {
        funding_type: "bank_transfer",
        bank_transfer: { type: "eu_bank_transfer", eu_bank_transfer: { country: "FR" } },
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: remaining,
          product_data: { name: label },
        },
      },
    ],
    metadata: {
      erpKind: "invoice",
      erpInvoiceId: invoice.id,
      erpMilestoneId: invoice.milestoneId ?? "",
    },
    payment_intent_data: {
      metadata: {
        erpKind: "invoice",
        erpInvoiceId: invoice.id,
        erpMilestoneId: invoice.milestoneId ?? "",
      },
    },
    success_url: redirects.success,
    cancel_url: redirects.cancel,
  });

  if (!session.url) {
    throw new StripeCheckoutError("Stripe n'a pas renvoyé d'URL de paiement", 502);
  }
  return session.url;
}

/**
 * Jalon payable : devis signé, et jalon exigible. Le 2e acompte d'un paiement en 3 fois reste
 * en attente de son étape de projet (PENDING) : il ne se paie pas avant.
 */
export function assertMilestonePayable(milestone: {
  status: MilestoneStatus;
  position: number;
  quote: { quoteStatus: QuoteStatus | null; paymentPlan: string | null; billingMode?: string | null };
}): void {
  if (milestone.quote.quoteStatus !== QuoteStatus.ACCEPTED) {
    throw new StripeCheckoutError("Le devis n'est pas encore signé", 409);
  }
  if (!milestone.quote.billingMode && milestone.quote.paymentPlan === "THREE" && milestone.position === 2 && milestone.status === MilestoneStatus.PENDING) {
    throw new StripeCheckoutError("Ce 2e acompte attend l'étape de projet prévue", 409);
  }
}

/** Session Checkout ponctuelle pour un jalon (acompte / solde). */
export async function createMilestoneCheckoutSession(milestoneId: string): Promise<string> {
  await assertStripeEnabled();
  const milestone = await prisma.paymentMilestone.findUnique({
    where: { id: milestoneId },
    include: { quote: true },
  });
  if (!milestone) throw new StripeCheckoutError("Jalon introuvable", 404);
  if (
    milestone.status === MilestoneStatus.PAID ||
    milestone.status === MilestoneStatus.CANCELLED
  ) {
    throw new StripeCheckoutError("Ce jalon est déjà réglé ou annulé", 409);
  }
  if (milestone.amountCents <= 0) {
    throw new StripeCheckoutError("Montant invalide", 400);
  }
  if (milestone.paymentProcessingAt) throw new StripeCheckoutError(PROCESSING_NOTICE, 409);
  assertMilestonePayable(milestone);

  // Si une facture est déjà liée, on paie la facture (reste dû).
  if (milestone.invoiceId) {
    return createInvoiceCheckoutSession(milestone.invoiceId);
  }

  const stripe = await getStripe();
  const customerId = await ensureStripeCustomer(milestone.quote.clientId);
  const redirects = await portalRedirect();
  const quoteRef = milestone.quote.number ?? "brouillon";
  const label = `${milestone.label} - devis ${quoteRef}`;

  const session = await createCheckoutSession(stripe, {
    mode: "payment",
    customer: customerId,
    allowed_payment_method_types: paymentMethodTypes(milestone.amountCents, await getCompanySettings()),
    payment_method_options: {
      customer_balance: {
        funding_type: "bank_transfer",
        bank_transfer: { type: "eu_bank_transfer", eu_bank_transfer: { country: "FR" } },
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "eur",
          unit_amount: milestone.amountCents,
          product_data: { name: label },
        },
      },
    ],
    metadata: {
      erpKind: "milestone",
      erpMilestoneId: milestone.id,
      erpInvoiceId: "",
    },
    payment_intent_data: {
      metadata: {
        erpKind: "milestone",
        erpMilestoneId: milestone.id,
        erpInvoiceId: "",
      },
    },
    success_url: redirects.success,
    cancel_url: redirects.cancel,
  });

  if (!session.url) {
    throw new StripeCheckoutError("Stripe n'a pas renvoyé d'URL de paiement", 502);
  }
  return session.url;
}

/**
 * Prix de l'échéance : le montant de l'abonnement ERP et sa périodicité (mensuelle ou annuelle).
 * La prestation Stripe liée sert de produit si elle existe dans le mode de la clé (keyLive) ;
 * sinon, le libellé de l'abonnement.
 */
export function subscriptionPriceData(
  sub: {
    amountCents: number;
    billingInterval: string | null;
    label: string;
    service: { stripeProductId: string | null; billingInterval: string | null; stripeLivemode?: boolean | null };
  },
  keyLive?: boolean,
) {
  const period = normalizeInterval(sub.billingInterval ?? sub.service.billingInterval);
  // Trimestriel : Stripe n'a pas d'intervalle « quarter », c'est tous les 3 mois.
  const recurring =
    period === "YEAR"
      ? ({ interval: "year" } as const)
      : period === "QUARTER"
        ? ({ interval: "month", interval_count: 3 } as const)
        : ({ interval: "month" } as const);
  const productUsable =
    sub.service.stripeProductId &&
    (keyLive === undefined || sub.service.stripeLivemode == null || sub.service.stripeLivemode === keyLive);
  return {
    currency: "eur",
    unit_amount: sub.amountCents,
    recurring,
    ...(productUsable ? { product: sub.service.stripeProductId! } : { product_data: { name: sub.label } }),
  } as const;
}

/** Session Checkout abonnement (prélèvement SEPA + carte). */
/** Délai minimal de trial_end dans une session Checkout (doc Stripe : « at least 48 hours in the future »), plus une marge. */
const TRIAL_MIN_MS = 48 * 3_600_000 + 10 * 60_000;

/**
 * Première échéance Stripe alignée sur nextInvoiceAt (jour de prélèvement compris) :
 * - plus de 48 h : trial_end, qui ancre aussi le cycle de facturation sur cette date (doc Stripe, Billing cycle) ;
 * - moins de 48 h : billing_cycle_anchor futur et proration_behavior none, période initiale gratuite (trial_end y serait
 *   refusé ; Checkout ne combine pas les deux) ;
 * - passée ou immédiate : 1re période prélevée tout de suite.
 */
export function firstChargeTiming(nextInvoiceAt: Date, now = Date.now()):
  | { trial_end: number }
  | { billing_cycle_anchor: number; proration_behavior: "none" }
  | Record<string, never> {
  const at = nextInvoiceAt.getTime();
  const seconds = Math.floor(at / 1000);
  if (at > now + TRIAL_MIN_MS) return { trial_end: seconds };
  if (at > now + 60_000) return { billing_cycle_anchor: seconds, proration_behavior: "none" };
  return {};
}

export async function createSubscriptionCheckoutSession(
  subscriptionId: string,
): Promise<string> {
  await assertStripeEnabled();
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { service: true, client: true },
  });
  if (!sub) throw new StripeCheckoutError("Abonnement introuvable", 404);
  if (sub.status === SubscriptionStatus.ENDED) {
    throw new StripeCheckoutError("Cet abonnement est terminé", 409);
  }
  if (sub.stripeSubscriptionId) {
    throw new StripeCheckoutError("Le prélèvement Stripe est déjà en place", 409);
  }
  if (sub.amountCents <= 0) {
    throw new StripeCheckoutError("Montant d'abonnement invalide", 400);
  }

  const stripe = await getStripe();
  const customerId = await ensureStripeCustomer(sub.clientId);
  const redirects = await portalRedirect();

  const timing = firstChargeTiming(sub.nextInvoiceAt);
  // Remise du devis signé (R2) : coupon Stripe sur les échéances remisées restantes.
  const coupon = await ensureSubscriptionCoupon(stripe, sub);

  const session = await createCheckoutSession(stripe, {
    mode: "subscription",
    customer: customerId,
    allowed_payment_method_types: subscriptionMethodTypes(sub.amountCents, await getCompanySettings()),
    line_items: [{ price_data: subscriptionPriceData(sub, await keyLivemode()), quantity: 1 }],
    ...(coupon ? { discounts: [{ coupon }] } : {}),
    subscription_data: {
      metadata: { erpSubscriptionId: sub.id, erpClientId: sub.clientId },
      ...timing,
    },
    metadata: {
      erpKind: "subscribe",
      erpSubscriptionId: sub.id,
    },
    success_url: redirects.success,
    cancel_url: redirects.cancel,
  });

  if (!session.url) {
    throw new StripeCheckoutError("Stripe n'a pas renvoyé d'URL d'abonnement", 502);
  }
  return session.url;
}
