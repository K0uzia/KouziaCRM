import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  PaymentMethod,
  SubscriptionCollectionMethod,
  SubscriptionStatus,
} from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { issueInvoiceWithin } from "@/lib/invoices/transitions.js";
import { sendDocumentPdf } from "@/lib/email/send-document-pdf.js";
import { getStripe } from "@/lib/stripe/client.js";
import { markInvoicePaidFromStripeBilling } from "@/lib/stripe/mark-paid.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { decryptOptional } from "@/lib/crypto.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { renderEmailHtml } from "@/lib/email/layout.js";

/** Relie l'abonnement ERP à Stripe après Checkout mode=subscription. */
export async function linkSubscriptionFromCheckout(opts: {
  erpSubscriptionId: string;
  stripeSubscriptionId: string;
}): Promise<void> {
  await prisma.subscription.update({
    where: { id: opts.erpSubscriptionId },
    data: {
      stripeSubscriptionId: opts.stripeSubscriptionId,
      collectionMethod: SubscriptionCollectionMethod.STRIPE,
      status: SubscriptionStatus.ACTIVE,
    },
  });
}

/** Identifiant Subscription Stripe (API Stripe 2025+ : parent.subscription_details). */
export function stripeInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const details = invoice.parent?.subscription_details;
  if (!details) return null;
  const sub = details.subscription;
  return typeof sub === "string" ? sub : sub?.id ?? null;
}

/** PaymentIntent lié à une Invoice Billing (via payments[].payment). */
export function stripeInvoicePaymentIntentId(invoice: Stripe.Invoice): string | null {
  const list = invoice.payments?.data;
  if (!list?.length) return null;
  for (const p of list) {
    const pi = p.payment?.payment_intent;
    if (pi) return typeof pi === "string" ? pi : pi.id;
  }
  return null;
}

/** Émet la facture ERP à partir d'une Invoice Stripe Billing finalisée. */
export async function issueErpInvoiceFromStripeInvoice(
  stripeInvoice: Stripe.Invoice,
): Promise<{ invoiceId: string; created: boolean }> {
  if (stripeInvoice.id) {
    const existing = await prisma.invoice.findUnique({
      where: { stripeInvoiceId: stripeInvoice.id },
    });
    if (existing) return { invoiceId: existing.id, created: false };
  }

  const stripeSubId = stripeInvoiceSubscriptionId(stripeInvoice);
  if (!stripeSubId) {
    throw new Error("Invoice Stripe sans abonnement");
  }

  const sub = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: stripeSubId },
    include: { client: true, service: true },
  });
  if (!sub) {
    throw new Error(`Abonnement ERP introuvable pour ${stripeSubId}`);
  }

  const amountCents =
    stripeInvoice.amount_due ??
    stripeInvoice.amount_paid ??
    sub.amountCents;
  const periodStart = stripeInvoice.period_start
    ? new Date(stripeInvoice.period_start * 1000)
    : new Date();
  const periodEnd = stripeInvoice.period_end
    ? new Date(stripeInvoice.period_end * 1000)
    : null;
  const label = periodEnd
    ? `${sub.label} (${periodStart.toLocaleDateString("fr-FR")} - ${periodEnd.toLocaleDateString("fr-FR")})`
    : sub.label;

  const settings = await getCompanySettings();
  const issued = await prisma.$transaction(async (tx) => {
    const again = stripeInvoice.id
      ? await tx.invoice.findUnique({ where: { stripeInvoiceId: stripeInvoice.id } })
      : null;
    if (again) return again;

    const invoice = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: sub.clientId,
        subscriptionId: sub.id,
        stripeInvoiceId: stripeInvoice.id,
        paymentTerms: "Prélèvement : paiement à réception",
        subtotalCents: amountCents,
        totalCents: amountCents,
        lines: {
          create: {
            position: 1,
            description: label,
            quantity: 1,
            unitPriceCents: amountCents,
            lineTotalCents: amountCents,
          },
        },
      },
    });

    const emitted = await issueInvoiceWithin(tx, invoice.id, periodStart, periodStart, settings);

    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        lastInvoiceId: emitted.id,
        nextInvoiceAt: periodEnd ?? sub.nextInvoiceAt,
        amountCents: amountCents > 0 ? amountCents : sub.amountCents,
      },
    });

    return emitted;
  });

  // Pas d'e-mail Stripe : l'ERP envoie sa facture (impayée tant que invoice.paid n'est pas reçu).
  await sendDocumentPdf(issued.id);
  return { invoiceId: issued.id, created: true };
}

export async function handleStripeInvoicePaid(
  stripeInvoice: Stripe.Invoice,
): Promise<void> {
  if (!stripeInvoice.id) return;
  let erp = await prisma.invoice.findUnique({
    where: { stripeInvoiceId: stripeInvoice.id },
  });
  if (!erp) {
    const created = await issueErpInvoiceFromStripeInvoice(stripeInvoice);
    erp = await prisma.invoice.findUniqueOrThrow({ where: { id: created.invoiceId } });
  }

  const paymentIntentId = stripeInvoicePaymentIntentId(stripeInvoice);

  let feeCents: number | null = null;
  let method: PaymentMethod = PaymentMethod.SEPA_DEBIT;
  if (paymentIntentId) {
    try {
      const stripe = await getStripe();
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge.balance_transaction"],
      });
      const charge = pi.latest_charge;
      if (charge && typeof charge !== "string") {
        const bt = charge.balance_transaction;
        if (bt && typeof bt !== "string") {
          feeCents = bt.fee;
        }
        if (charge.payment_method_details?.type === "card") {
          method = PaymentMethod.CARD;
        }
      }
    } catch {
      /* frais optionnels */
    }
  }

  await markInvoicePaidFromStripeBilling({
    erpInvoiceId: erp.id,
    paymentIntentId,
    amountCents: stripeInvoice.amount_paid ?? erp.totalCents,
    feeCents,
    method,
  });
}

export async function syncSubscriptionFromStripe(
  stripeSub: Stripe.Subscription,
): Promise<void> {
  const erpId = stripeSub.metadata?.erpSubscriptionId;
  const sub = erpId
    ? await prisma.subscription.findUnique({ where: { id: erpId } })
    : await prisma.subscription.findUnique({
        where: { stripeSubscriptionId: stripeSub.id },
      });
  if (!sub) return;

  const price = stripeSub.items.data[0]?.price;
  const amountCents = price?.unit_amount ?? sub.amountCents;
  const interval =
    price?.recurring?.interval === "year"
      ? "YEAR"
      : price?.recurring?.interval === "month"
        ? "MONTH"
        : sub.billingInterval;

  let status: SubscriptionStatus = sub.status;
  if (stripeSub.status === "canceled" || stripeSub.status === "unpaid") {
    status = SubscriptionStatus.ENDED;
  } else if (stripeSub.status === "paused") {
    status = SubscriptionStatus.PAUSED;
  } else if (
    stripeSub.status === "active" ||
    stripeSub.status === "trialing" ||
    stripeSub.status === "past_due"
  ) {
    status = SubscriptionStatus.ACTIVE;
  }

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      stripeSubscriptionId: stripeSub.id,
      collectionMethod: SubscriptionCollectionMethod.STRIPE,
      amountCents: amountCents ?? sub.amountCents,
      billingInterval: interval,
      status,
      endDate:
        status === SubscriptionStatus.ENDED
          ? new Date((stripeSub.ended_at ?? Date.now() / 1000) * 1000)
          : sub.endDate,
    },
  });
}

/** Envoie au client le lien pour mettre en place le prélèvement Stripe. */
export async function sendSubscriptionSetupEmail(subscriptionId: string): Promise<void> {
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { client: true },
  });
  if (!sub) return;
  const email = decryptOptional(sub.client.emailEncrypted);
  if (!email) return;

  const settings = await getCompanySettings();
  const brand = buildEmailBrand(settings);
  const url = buildPayUrl("subscribe", sub.id);
  const text = [
    `Bonjour ${sub.client.firstName?.trim() || sub.client.displayName},`,
    "",
    `Pour activer le prélèvement de votre abonnement « ${sub.label} », cliquez sur le lien ci-dessous :`,
    "",
    url,
    "",
    "Vous pourrez choisir un prélèvement SEPA ou une carte bancaire.",
    "",
    formatPlainTextSignature(settings, brand),
  ].join("\n");

  const html = renderEmailHtml({
    text,
    brand,
    colors: { brandPrimaryColor: settings.brandPrimaryColor },
    paymentUrl: url,
    paymentLabel: "Activer le prélèvement",
  });

  await mailEnqueue({
    to: email,
    subject: `Activer le prélèvement - ${sub.label}`,
    text,
    html,
    clientId: sub.clientId,
    kind: "subscription_setup",
    bodyTextForMessage: text,
  });
}
