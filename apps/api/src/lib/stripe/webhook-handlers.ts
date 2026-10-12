import { PaymentMethod } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
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

async function recordEvent(event: Stripe.Event): Promise<boolean> {
  try {
    await prisma.stripeWebhookEvent.create({
      data: {
        eventId: event.id,
        eventType: event.type,
        payload: event as unknown as object,
      },
    });
    return false;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2002") return true; // déjà traité
    throw err;
  }
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
  const duplicate = await recordEvent(event);
  if (duplicate) return { duplicate: true, handled: event.type };

  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata ?? {};
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
      if (invoice.billing_reason?.startsWith("subscription") || invoice.parent?.subscription_details) {
        await issueErpInvoiceFromStripeInvoice(invoice);
      }
      break;
    }
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      if (invoice.billing_reason?.startsWith("subscription") || invoice.parent?.subscription_details) {
        await handleStripeInvoicePaid(invoice);
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      await alertAdmin(
        "Échec de prélèvement Stripe",
        `La facture Stripe ${invoice.id} a échoué (montant ${(invoice.amount_due / 100).toFixed(2)} €). Stripe retentera automatiquement.`,
      );
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await syncSubscriptionFromStripe(event.data.object as Stripe.Subscription);
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
        },
        update: {
          amountCents: payout.amount,
          arrivalDate: payout.arrival_date
            ? new Date(payout.arrival_date * 1000)
            : null,
          status: payout.status,
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
          `Le versement ${payout.id} (${(payout.amount / 100).toFixed(2)} €) vers Revolut a échoué (${payout.failure_message ?? payout.status}).`,
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
        `Un remboursement a été effectué sur ${charge.id} (${(charge.amount_refunded / 100).toFixed(2)} €). Créez un avoir dans l'ERP si besoin.`,
      );
      break;
    }
    case "charge.dispute.created": {
      const dispute = event.data.object as Stripe.Dispute;
      await alertAdmin(
        "Litige Stripe",
        `Un litige a été ouvert (${dispute.id}) pour ${(dispute.amount / 100).toFixed(2)} €. Motif : ${dispute.reason}.`,
      );
      break;
    }
    default:
      break;
  }

  return { duplicate: false, handled: event.type };
}
