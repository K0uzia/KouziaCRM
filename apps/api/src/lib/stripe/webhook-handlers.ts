import { PaymentMethod } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { formatEUR } from "@/lib/money.js";
import { getCompanySettings } from "@/lib/company.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { getStripe } from "@/lib/stripe/client.js";
import { syncCatalogFromStripe } from "@/lib/stripe/catalog.js";
import {
  handleStripeInvoicePaid,
  issueErpInvoiceFromStripeInvoice,
  linkSubscriptionFromCheckout,
  syncSubscriptionFromStripe,
} from "@/lib/stripe/billing.js";
import {
  markMilestoneFailedFromStripe,
  markPaidFromOnlinePayment,
} from "@/lib/stripe/mark-paid.js";

/** Événement déjà traité avec succès ? */
async function alreadyProcessed(event: Stripe.Event): Promise<boolean> {
  return Boolean(await prisma.stripeWebhookEvent.findUnique({ where: { eventId: event.id } }));
}

/**
 * Marque l'événement traité, APRÈS le traitement : en cas d'échec, la route répond 500 et le renvoi
 * de Stripe est retraité (les traitements sont eux-mêmes idempotents : PaymentIntent, Invoice).
 */
async function recordEvent(event: Stripe.Event): Promise<void> {
  try {
    await prisma.stripeWebhookEvent.create({
      data: {
        eventId: event.id,
        eventType: event.type,
        payload: event as unknown as object,
      },
    });
  } catch (err) {
    // Deux livraisons simultanées du même événement : la seconde trouve la ligne déjà écrite.
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
}

/** Facture Billing d'abonnement à 0 € (essai, alignement de la première échéance) : aucune facture ERP. */
function isZeroAmountInvoice(invoice: Stripe.Invoice): boolean {
  return (invoice.amount_due ?? 0) <= 0 && (invoice.total ?? 0) <= 0;
}

function isSubscriptionInvoice(invoice: Stripe.Invoice): boolean {
  return Boolean(invoice.billing_reason?.startsWith("subscription") || invoice.parent?.subscription_details);
}

async function alertAdmin(subject: string, text: string): Promise<void> {
  const settings = await getCompanySettings();
  const to = settings.email?.trim();
  if (!to) return;
  await mailEnqueue({
    to,
    subject,
    text,
    kind: "stripe_alert",
    bodyTextForMessage: text,
  });
}

async function feeFromPaymentIntent(pi: Stripe.PaymentIntent): Promise<number | null> {
  try {
    const stripe = await getStripe();
    const full = await stripe.paymentIntents.retrieve(pi.id, {
      expand: ["latest_charge.balance_transaction"],
    });
    const charge = full.latest_charge;
    if (!charge || typeof charge === "string") return null;
    const bt = charge.balance_transaction;
    if (!bt || typeof bt === "string") return null;
    return bt.fee;
  } catch {
    return null;
  }
}

function methodFromPaymentIntent(pi: Stripe.PaymentIntent): PaymentMethod {
  const types = pi.payment_method_types ?? [];
  if (types.includes("sepa_debit")) return PaymentMethod.SEPA_DEBIT;
  if (types.includes("customer_balance")) return PaymentMethod.BANK_TRANSFER;
  return PaymentMethod.CARD;
}

export async function processStripeEvent(event: Stripe.Event): Promise<{
  duplicate: boolean;
  handled: string;
}> {
  if (await alreadyProcessed(event)) return { duplicate: true, handled: event.type };
  const handled = await handleEvent(event);
  await recordEvent(event);
  return { duplicate: false, handled };
}

async function handleEvent(event: Stripe.Event): Promise<string> {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata ?? {};
      // Prélèvement d'abonnement (Billing) : pas de métadonnées ERP, invoice.paid s'en charge.
      if (!meta.erpInvoiceId && !meta.erpMilestoneId) return `${event.type}:ignoré (sans document ERP)`;
      const feeCents = await feeFromPaymentIntent(pi);
      await markPaidFromOnlinePayment({
        amountCents: pi.amount_received || pi.amount,
        method: methodFromPaymentIntent(pi),
        paymentIntentId: pi.id,
        feeCents,
        milestoneId: meta.erpMilestoneId || null,
        invoiceId: meta.erpInvoiceId || null,
        notes: "Paiement Stripe",
      });
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const milestoneId = pi.metadata?.erpMilestoneId;
      if (milestoneId) {
        await markMilestoneFailedFromStripe({
          milestoneId,
          reason: pi.last_payment_error?.message ?? "Échec de paiement Stripe",
        });
      }
      break;
    }
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription" && session.subscription) {
        const erpSubscriptionId = session.metadata?.erpSubscriptionId;
        const stripeSubId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
        if (erpSubscriptionId && stripeSubId) {
          await linkSubscriptionFromCheckout({
            erpSubscriptionId,
            stripeSubscriptionId: stripeSubId,
          });
        }
      }
      break;
    }
    case "invoice.finalized": {
      const invoice = event.data.object as Stripe.Invoice;
      if (isZeroAmountInvoice(invoice)) return `${event.type}:ignoré (0 €)`;
      if (isSubscriptionInvoice(invoice)) await issueErpInvoiceFromStripeInvoice(invoice);
      break;
    }
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      if (isZeroAmountInvoice(invoice)) return `${event.type}:ignoré (0 €)`;
      if (isSubscriptionInvoice(invoice)) await handleStripeInvoicePaid(invoice);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      await alertAdmin(
        "Échec de prélèvement Stripe",
        `La facture Stripe ${invoice.id} a échoué (montant ${formatEUR(invoice.amount_due)}). Stripe retentera automatiquement.`,
      );
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const change = await syncSubscriptionFromStripe(event.data.object as Stripe.Subscription);
      if (change) {
        const state = change.to === "ENDED" ? "clôturé" : change.to === "PAUSED" ? "suspendu" : "repris";
        await alertAdmin(
          `Abonnement ${state} depuis Stripe : ${change.clientName}`,
          `L'abonnement « ${change.label} » de ${change.clientName} est passé à « ${state} » dans l'ERP (${change.reason}). Aucune action n'a été faite depuis l'ERP : vérifiez la situation avec le client.`,
        );
      }
      break;
    }
    case "product.created":
    case "product.updated":
    case "product.deleted":
    case "price.created":
    case "price.updated":
    case "price.deleted": {
      await syncCatalogFromStripe();
      break;
    }
    case "payout.paid":
    case "payout.failed": {
      const payout = event.data.object as Stripe.Payout;
      const row = await prisma.stripePayout.upsert({
        where: { stripePayoutId: payout.id },
        create: {
          stripePayoutId: payout.id,
          amountCents: payout.amount,
          arrivalDate: payout.arrival_date
            ? new Date(payout.arrival_date * 1000)
            : null,
          status: payout.status,
          failureMessage: payout.failure_message ?? null,
        },
        update: {
          amountCents: payout.amount,
          arrivalDate: payout.arrival_date
            ? new Date(payout.arrival_date * 1000)
            : null,
          status: payout.status,
          failureMessage: payout.failure_message ?? null,
        },
      });

      if (event.type === "payout.paid") {
        try {
          const stripe = await getStripe();
          const txs = await stripe.balanceTransactions.list({
            payout: payout.id,
            type: "charge",
            limit: 100,
          });
          for (const tx of txs.data) {
            const source = typeof tx.source === "string" ? tx.source : tx.source?.id;
            if (!source) continue;
            // Charge id → PaymentIntent via charge retrieve
            const charge = await stripe.charges.retrieve(source);
            const piId =
              typeof charge.payment_intent === "string"
                ? charge.payment_intent
                : charge.payment_intent?.id;
            if (!piId) continue;
            await prisma.payment.updateMany({
              where: { stripePaymentIntentId: piId },
              data: { stripePayoutId: row.id },
            });
          }
        } catch (err) {
          console.error("[stripe] liaison payout", err);
        }
      } else {
        await alertAdmin(
          "Échec de versement Stripe",
          `Le versement ${payout.id} (${formatEUR(payout.amount)}) vers le compte bancaire a échoué (${payout.failure_message ?? payout.status}).`,
        );
      }
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const piId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : charge.payment_intent?.id;
      if (piId) {
        const payment = await prisma.payment.findUnique({
          where: { stripePaymentIntentId: piId },
        });
        if (payment) {
          await prisma.payment.update({
            where: { id: payment.id },
            data: {
              notes: [payment.notes, "Remboursé Stripe"].filter(Boolean).join(" | "),
            },
          });
        }
      }
      await alertAdmin(
        "Remboursement Stripe",
        `Un remboursement a été effectué sur ${charge.id} (${formatEUR(charge.amount_refunded)}). Créez un avoir dans l'ERP si besoin.`,
      );
      break;
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      await alertAdmin(
        "Litige Stripe",
        `Un litige a été ouvert (${dispute.id}) pour ${formatEUR(dispute.amount)}. Motif : ${dispute.reason}.`,
      );
      break;
    }
    default:
      break;
  }
  return event.type;
}
