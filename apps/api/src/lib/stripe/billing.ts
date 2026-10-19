import { subscriptionMethodTypes, subscriptionMethodsSentence } from "@/lib/stripe/payment-methods.js";
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
import { archiveIssuedDocument } from "@/lib/pdf/issued-archive.js";
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
import { formatDateFr } from "@/lib/format-fr.js";

/** Relie l'abonnement ERP à Stripe après Checkout mode=subscription. */
export async function linkSubscriptionFromCheckout(opts: {
  erpSubscriptionId: string;
  stripeSubscriptionId: string;
  /** Mode de l'objet Stripe (event.livemode). */
  livemode: boolean;
}): Promise<void> {
  await prisma.subscription.update({
    where: { id: opts.erpSubscriptionId },
    data: {
      stripeSubscriptionId: opts.stripeSubscriptionId,
      stripeLivemode: opts.livemode,
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

/** Abonnement ERP visé par une facture Stripe : métadonnées de la facture, sinon de l'abonnement Stripe. */
async function erpSubscriptionIdOf(stripeInvoice: Stripe.Invoice, stripeSubId: string): Promise<string | null> {
  const fromInvoice = stripeInvoice.parent?.subscription_details?.metadata?.erpSubscriptionId;
  if (fromInvoice) return fromInvoice;
  try {
    const stripeSub = await (await getStripe()).subscriptions.retrieve(stripeSubId);
    return stripeSub.metadata?.erpSubscriptionId ?? null;
  } catch {
    return null;
  }
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

  let sub = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId: stripeSubId },
    include: { client: true, service: true },
  });
  if (!sub) {
    // Sans période d'essai, la 1re facture (invoice.finalized) peut arriver avant
    // checkout.session.completed : liaison par les métadonnées posées à la création du Checkout.
    const erpId = await erpSubscriptionIdOf(stripeInvoice, stripeSubId);
    const candidate = erpId ? await prisma.subscription.findUnique({ where: { id: erpId } }) : null;
    if (candidate && !candidate.stripeSubscriptionId) {
      await linkSubscriptionFromCheckout({
        erpSubscriptionId: candidate.id,
        stripeSubscriptionId: stripeSubId,
        livemode: stripeInvoice.livemode,
      });
      sub = await prisma.subscription.findUnique({
        where: { stripeSubscriptionId: stripeSubId },
        include: { client: true, service: true },
      });
    }
  }
  if (!sub) {
    throw new Error(`Abonnement ERP introuvable pour ${stripeSubId}`);
  }

  const amountCents =
    stripeInvoice.amount_due ??
    stripeInvoice.amount_paid ??
    sub.amountCents;
  // Période facturée : celle de la ligne d'abonnement. Les champs period_* de la facture
  // désignent la période précédente (1re facture : début = fin), pas l'échéance réglée.
  const linePeriod = stripeInvoice.lines?.data?.find((l) => l.period?.end)?.period;
  const startSec = linePeriod?.start ?? stripeInvoice.period_start;
  const endSec = linePeriod?.end ?? stripeInvoice.period_end;
  const periodStart = startSec ? new Date(startSec * 1000) : new Date();
  const periodEnd = endSec && endSec > (startSec ?? 0) ? new Date(endSec * 1000) : null;
  const label = periodEnd
    ? `${sub.label} (${formatDateFr(periodStart)} - ${formatDateFr(periodEnd)})`
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
  await archiveIssuedDocument(issued.id);
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

/**
 * État ERP correspondant à un abonnement Stripe (une pause Stripe garde le statut « active »).
 * « unpaid » (impayé après les relances) suspend sans clôturer : le paiement de l'échéance le relance.
 */
export function erpStatusFromStripe(
  stripeSub: Pick<Stripe.Subscription, "status" | "pause_collection">,
  current: SubscriptionStatus,
): SubscriptionStatus {
  const s = stripeSub.status;
  if (s === "canceled" || s === "incomplete_expired") return SubscriptionStatus.ENDED;
  if (s === "unpaid" || s === "paused" || stripeSub.pause_collection) return SubscriptionStatus.PAUSED;
  if (s === "active" || s === "trialing" || s === "past_due") return SubscriptionStatus.ACTIVE;
  return current;
}

export type StripeStatusChange = {
  subscriptionId: string;
  label: string;
  clientName: string;
  from: SubscriptionStatus;
  to: SubscriptionStatus;
  reason: string;
};

export type StripeSyncResult = {
  subscriptionId: string;
  /** Changement d'état venu de Stripe ; null si l'ERP était déjà dans cet état (action lancée depuis l'ERP). */
  change: StripeStatusChange | null;
  /** Vient de passer à « unpaid » : suspendu faute de paiement. */
  becameUnpaid: boolean;
  /** Résiliation en fin de période nouvellement programmée (portail client ou tableau de bord). */
  cancelScheduledAt: Date | null;
  /** Résiliation programmée puis annulée. */
  cancelRevoked: boolean;
};

/** Date de fin d'une résiliation programmée (cancel_at, ou fin de période si cancel_at_period_end). */
export function scheduledCancelDate(
  stripeSub: Pick<Stripe.Subscription, "status" | "cancel_at" | "cancel_at_period_end" | "items">,
): Date | null {
  if (stripeSub.status === "canceled" || stripeSub.status === "incomplete_expired") return null;
  if (stripeSub.cancel_at) return new Date(stripeSub.cancel_at * 1000);
  const periodEnd = stripeSub.items?.data?.[0]?.current_period_end;
  return stripeSub.cancel_at_period_end && periodEnd ? new Date(periodEnd * 1000) : null;
}

/**
 * Aligne l'abonnement ERP sur Stripe (montant, périodicité, état, résiliation programmée).
 * Le changement d'état est renseigné quand il vient de Stripe (résiliation ou pause faite dans
 * le tableau de bord, impayés après relances).
 */
export async function syncSubscriptionFromStripe(
  stripeSub: Stripe.Subscription,
): Promise<StripeSyncResult | null> {
  const erpId = stripeSub.metadata?.erpSubscriptionId;
  const sub = erpId
    ? await prisma.subscription.findUnique({ where: { id: erpId } })
    : await prisma.subscription.findUnique({
        where: { stripeSubscriptionId: stripeSub.id },
      });
  if (!sub) return null;

  const price = stripeSub.items.data[0]?.price;
  const amountCents = price?.unit_amount ?? sub.amountCents;
  const interval =
    price?.recurring?.interval === "year"
      ? "YEAR"
      : price?.recurring?.interval === "month"
        ? "MONTH"
        : sub.billingInterval;

  // Clôturé est définitif dans l'ERP : un événement Stripe tardif ne le rouvre pas.
  const status =
    sub.status === SubscriptionStatus.ENDED ? sub.status : erpStatusFromStripe(stripeSub, sub.status);
  const changed = status !== sub.status;
  const cancelAt = scheduledCancelDate(stripeSub);
  const becameUnpaid = stripeSub.status === "unpaid" && sub.stripeStatus !== "unpaid";
  const cancelScheduledAt = cancelAt && !sub.stripeCancelAt ? cancelAt : null;
  const cancelRevoked = !cancelAt && Boolean(sub.stripeCancelAt) && status !== SubscriptionStatus.ENDED;

  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      stripeSubscriptionId: stripeSub.id,
      stripeLivemode: stripeSub.livemode,
      collectionMethod: SubscriptionCollectionMethod.STRIPE,
      amountCents: amountCents ?? sub.amountCents,
      billingInterval: interval,
      status,
      stripeStatus: stripeSub.status,
      stripeCancelAt: cancelAt,
      ...(changed ? { stripeStatusChange: status, stripeStatusChangedAt: new Date() } : {}),
      endDate:
        status === SubscriptionStatus.ENDED
          ? new Date((stripeSub.ended_at ?? Date.now() / 1000) * 1000)
          : sub.endDate,
    },
  });

  const base = { subscriptionId: sub.id, becameUnpaid, cancelScheduledAt, cancelRevoked };
  if (!changed) return { ...base, change: null };
  const client = await prisma.client.findUnique({ where: { id: sub.clientId }, select: { displayName: true } });
  const reason =
    stripeSub.status === "unpaid"
      ? "échéance impayée après les relances Stripe : suspendu jusqu'au paiement"
      : stripeSub.cancellation_details?.reason === "payment_failed"
        ? "prélèvements impayés après les relances Stripe"
        : stripeSub.pause_collection || stripeSub.status === "paused"
          ? "prélèvement suspendu dans Stripe"
          : status === SubscriptionStatus.ACTIVE
            ? "prélèvement repris dans Stripe"
            : stripeSub.cancellation_details?.reason === "cancellation_requested"
              ? "résiliation demandée par le client"
              : "résiliation faite dans Stripe";
  return {
    ...base,
    change: {
      subscriptionId: sub.id,
      label: sub.label,
      clientName: client?.displayName ?? "Client",
      from: sub.status,
      to: status,
      reason,
    },
  };
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
    subscriptionMethodsSentence(subscriptionMethodTypes(sub.amountCents, settings)),
    "",
    formatPlainTextSignature(settings, brand),
  ].join("\n");

  const html = renderEmailHtml({
    text,
    brand,
    colors: { brandPrimaryColor: settings.brandPrimaryColor, brandSecondaryColor: settings.brandSecondaryColor },
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
