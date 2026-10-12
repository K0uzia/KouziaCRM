import {
  InvoiceDocumentType,
  InvoiceStatus,
  MilestoneStatus,
  QuoteStatus,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { assertStripeEnabled, getStripe } from "@/lib/stripe/client.js";
import { ensureStripeCustomer } from "@/lib/stripe/customers.js";

export class StripeCheckoutError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function portalRedirect(): Promise<{ success: string; cancel: string }> {
  const portal = await resolveClientPortalUrl();
  return { success: portal, cancel: portal };
}

/** Session Checkout ponctuelle (carte + virement) pour une facture. */
export async function createInvoiceCheckoutSession(invoiceId: string): Promise<string> {
  await assertStripeEnabled();
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: true, client: true },
  });
  if (!invoice || invoice.documentType !== InvoiceDocumentType.INVOICE) {
    throw new StripeCheckoutError("Facture introuvable", 404);
  }
  if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.CANCELLED) {
    throw new StripeCheckoutError("Cette facture est déjà réglée ou annulée", 409);
  }

  const paid = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
  const remaining = invoice.totalCents - paid;
  if (remaining <= 0) {
    throw new StripeCheckoutError("Cette facture est déjà soldée", 409);
  }

  const stripe = await getStripe();
  const customerId = await ensureStripeCustomer(invoice.clientId);
  const redirects = await portalRedirect();
  const label = invoice.number
    ? `Facture ${invoice.number}`
    : `Facture ${invoice.id.slice(0, 8)}`;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    allowed_payment_method_types: ["card", "customer_balance"],
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
  quote: { quoteStatus: QuoteStatus | null; paymentPlan: string | null };
}): void {
  if (milestone.quote.quoteStatus !== QuoteStatus.ACCEPTED) {
    throw new StripeCheckoutError("Le devis n'est pas encore signé", 409);
  }
  if (milestone.quote.paymentPlan === "THREE" && milestone.position === 2 && milestone.status === MilestoneStatus.PENDING) {
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

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    allowed_payment_method_types: ["card", "customer_balance"],
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
 * La prestation Stripe liée sert de produit si elle existe ; sinon, le libellé de l'abonnement.
 */
export function subscriptionPriceData(sub: {
  amountCents: number;
  billingInterval: string | null;
  label: string;
  service: { stripeProductId: string | null; billingInterval: string | null };
}) {
  const interval = (sub.billingInterval ?? sub.service.billingInterval) === "YEAR" ? "year" : "month";
  return {
    currency: "eur",
    unit_amount: sub.amountCents,
    recurring: { interval },
    ...(sub.service.stripeProductId ? { product: sub.service.stripeProductId } : { product_data: { name: sub.label } }),
  } as const;
}

/** Session Checkout abonnement (prélèvement SEPA + carte). */
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

  // Première échéance alignée sur nextInvoiceAt si dans le futur.
  const trialEnd =
    sub.nextInvoiceAt.getTime() > Date.now() + 60_000
      ? Math.floor(sub.nextInvoiceAt.getTime() / 1000)
      : undefined;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    allowed_payment_method_types: ["card", "sepa_debit"],
    line_items: [{ price_data: subscriptionPriceData(sub), quantity: 1 }],
    subscription_data: {
      metadata: { erpSubscriptionId: sub.id, erpClientId: sub.clientId },
      ...(trialEnd ? { trial_end: trialEnd } : {}),
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
