import { PaymentMethod } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { formatEUR } from "@/lib/money.js";
import { getCompanySettings } from "@/lib/company.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { getStripe } from "@/lib/stripe/client.js";
import { syncCatalogFromStripe } from "@/lib/stripe/catalog.js";
import { alertAdmin } from "@/lib/stripe/alert.js";
import {
  clearInvoiceProcessing,
  markInvoiceProcessing,
  notifyInvoicePaymentFailed,
  notifyMilestonePaymentFailed,
  notifyMandateUpdated,
  recordSubscriptionPaymentMethod,
} from "@/lib/stripe/payment-processing.js";
import { keyLivemode, modeLabel } from "@/lib/stripe/mode.js";
import {
  handleStripeInvoicePaid,
  issueErpInvoiceFromStripeInvoice,
  linkSubscriptionFromCheckout,
  syncSubscriptionFromStripe,
} from "@/lib/stripe/billing.js";
import {
  handleStripeActionRequired,
  handleStripeInvoiceUncollectible,
  handleStripePaymentFailed,
  notifyStripePaymentRecovered,
  notifySubscriptionSync,
} from "@/lib/subscriptions/dunning.js";
import {
  markMilestoneFailedFromStripe,
  markPaidFromOnlinePayment,
} from "@/lib/stripe/mark-paid.js";

/**
 * État actuel d'un abonnement Stripe : les événements n'arrivent pas toujours dans l'ordre, un « updated » ancien
 * reçu après un plus récent écraserait l'état (audit du 25/10/2026). Stripe injoignable : l'état de l'événement.
 */
async function currentStripeSubscription(fromEvent: Stripe.Subscription): Promise<Stripe.Subscription> {
  try {
    const stripe = await getStripe();
    const fresh = await stripe.subscriptions.retrieve(fromEvent.id);
    // Réponse incomplète (autre abonnement, sans état) : l'état de l'événement reste la meilleure source.
    return fresh?.id === fromEvent.id && fresh.status ? fresh : fromEvent;
  } catch (err) {
    console.warn(`[stripe] relecture de l'abonnement ${fromEvent.id} impossible : état de l'événement utilisé`, err instanceof Error ? err.message : err);
    return fromEvent;
  }
}

/** Ligne « en cours » plus ancienne : traitement interrompu (arrêt brutal), repris par le renvoi suivant. */
const STALE_CLAIM_MS = 15 * 60_000;

/**
 * Réserve l'événement AVANT son traitement (décision du 27/10/2026) : ligne PROCESSING sous la contrainte unique
 * eventId. Une livraison simultanée du même événement échoue sur la contrainte et n'envoie ni e-mail ni alerte.
 * @returns true si ce passage traite l'événement.
 */
async function claimEvent(event: Stripe.Event): Promise<boolean> {
  try {
    await prisma.stripeWebhookEvent.create({
      data: { eventId: event.id, eventType: event.type, payload: event as unknown as object, status: "PROCESSING", claimedAt: new Date() },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
  }
  const retaken = await prisma.stripeWebhookEvent.updateMany({
    where: { eventId: event.id, status: "PROCESSING", claimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
    data: { claimedAt: new Date() },
  });
  return retaken.count === 1;
}

/** Traitement réussi : la ligne passe à DONE (processedAt = fin du traitement). */
async function completeEvent(event: Stripe.Event): Promise<void> {
  await prisma.stripeWebhookEvent.update({ where: { eventId: event.id }, data: { status: "DONE", processedAt: new Date() } });
}

/** Échec : la réservation est retirée, la route répond 500 et le renvoi de Stripe retraite l'événement. */
async function releaseEvent(event: Stripe.Event): Promise<void> {
  await prisma.stripeWebhookEvent.deleteMany({ where: { eventId: event.id, status: "PROCESSING" } });
}

/** Date de l'événement Stripe (création, en secondes) ; absente (revérification par le worker) : null, donc maintenant. */
function eventDate(event: Stripe.Event): Date | null {
  return typeof event.created === "number" && event.created > 0 ? new Date(event.created * 1000) : null;
}

/** Facture Billing d'abonnement à 0 €(essai, alignement de la première échéance) : aucune facture ERP. */
function isZeroAmountInvoice(invoice: Stripe.Invoice): boolean {
  return (invoice.amount_due ?? 0) <= 0 && (invoice.total ?? 0) <= 0;
}

function isSubscriptionInvoice(invoice: Stripe.Invoice): boolean {
  return Boolean(invoice.billing_reason?.startsWith("subscription") || invoice.parent?.subscription_details);
}


/** Moyen réellement utilisé (charge), pas la liste des moyens proposés au client. */
export function methodFromChargeType(type: string | undefined): PaymentMethod {
  if (type === "sepa_debit") return PaymentMethod.SEPA_DEBIT;
  if (type === "customer_balance") return PaymentMethod.BANK_TRANSFER;
  return PaymentMethod.CARD;
}

/**
 * Moyen utilisé et frais Stripe d'un paiement. Les frais (balance transaction) arrivent souvent
 * après payment_intent.succeeded : null ici, complétés par charge.updated.
 */
async function chargeDetails(pi: Stripe.PaymentIntent): Promise<{ method: PaymentMethod; feeCents: number | null }> {
  try {
    const stripe = await getStripe();
    const full = await stripe.paymentIntents.retrieve(pi.id, { expand: ["latest_charge.balance_transaction"] });
    const charge = full.latest_charge;
    if (!charge || typeof charge === "string") return { method: methodFromChargeType(undefined), feeCents: null };
    const bt = charge.balance_transaction;
    return {
      method: methodFromChargeType(charge.payment_method_details?.type),
      feeCents: bt && typeof bt !== "string" ? bt.fee : null,
    };
  } catch {
    return { method: methodFromChargeType(undefined), feeCents: null };
  }
}

export async function processStripeEvent(event: Stripe.Event): Promise<{
  duplicate: boolean;
  handled: string;
}> {
  if (!(await claimEvent(event))) return { duplicate: true, handled: event.type };
  try {
    // Événement de l'autre mode (clé test en production, ou l'inverse) : ignoré, il ne doit
    // modifier ni le catalogue ni les abonnements.
    const live = await keyLivemode();
    if (typeof event.livemode === "boolean" && event.livemode !== live) {
      await completeEvent(event);
      return { duplicate: false, handled: `ignoré (événement ${modeLabel(event.livemode)}, clé ${modeLabel(live)})` };
    }
    const handled = await handleEvent(event);
    await completeEvent(event);
    return { duplicate: false, handled };
  } catch (err) {
    await releaseEvent(event).catch(() => undefined);
    throw err;
  }
}

async function handleEvent(event: Stripe.Event): Promise<string> {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata ?? {};
      // Prélèvement d'abonnement (Billing) : pas de métadonnées ERP, invoice.paid s'en charge.
      if (!meta.erpInvoiceId && !meta.erpMilestoneId) return `${event.type}:ignoré (sans document ERP)`;
      const { method, feeCents } = await chargeDetails(pi);
      await markPaidFromOnlinePayment({
        amountCents: pi.amount_received || pi.amount,
        method,
        paymentIntentId: pi.id,
        feeCents,
        milestoneId: meta.erpMilestoneId || null,
        invoiceId: meta.erpInvoiceId || null,
        notes: "Paiement Stripe",
        paidAt: eventDate(event),
      });
      await clearInvoiceProcessing(pi);
      break;
    }
    case "payment_intent.processing": {
      return `${event.type}:${await markInvoiceProcessing(event.data.object as Stripe.PaymentIntent)}`;
    }
    case "mandate.updated": {
      return `${event.type}:${await notifyMandateUpdated(event.data.object as Stripe.Mandate)}`;
    }
    case "charge.updated": {
      // Frais Stripe connus après coup : complète le paiement ERP enregistré sans frais.
      const charge = event.data.object as Stripe.Charge;
      const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
      if (!piId || !charge.balance_transaction) return `${event.type}:ignoré`;
      const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: piId } });
      if (!payment || payment.feeCents !== null) return `${event.type}:rien à compléter`;
      const stripe = await getStripe();
      const btId = typeof charge.balance_transaction === "string" ? charge.balance_transaction : charge.balance_transaction.id;
      const bt = await stripe.balanceTransactions.retrieve(btId);
      await prisma.payment.update({ where: { id: payment.id }, data: { feeCents: bt.fee } });
      break;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const milestoneId = pi.metadata?.erpMilestoneId;
      // Lu avant la mise en échec : seul un prélèvement « en cours » refusé après coup prévient le client.
      const wasProcessing = milestoneId
        ? Boolean((await prisma.paymentMilestone.findUnique({ where: { id: milestoneId }, select: { paymentProcessingAt: true } }))?.paymentProcessingAt)
        : false;
      if (milestoneId) {
        await markMilestoneFailedFromStripe({
          milestoneId,
          reason: pi.last_payment_error?.message ?? "Échec de paiement Stripe",
        });
      }
      // Facture (lien de facture, ou échéance déjà facturée) : redevient à régler, admin et client prévenus.
      if (pi.metadata?.erpInvoiceId) return `${event.type}:${await notifyInvoicePaymentFailed(pi)}`;
      if (milestoneId) return `${event.type}:${await notifyMilestonePaymentFailed(pi, wasProcessing)}`;
      await clearInvoiceProcessing(pi);
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
            livemode: event.livemode,
          });
          await recordSubscriptionPaymentMethod(erpSubscriptionId, stripeSubId);
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
      if (!isSubscriptionInvoice(invoice)) break;
      await handleStripeInvoicePaid(invoice, eventDate(event));
      const erp = invoice.id ? await prisma.invoice.findUnique({ where: { stripeInvoiceId: invoice.id } }) : null;
      if (erp && (await notifyStripePaymentRecovered(erp.id))) return `${event.type}:régularisation signalée`;
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      if (isZeroAmountInvoice(invoice) || !isSubscriptionInvoice(invoice)) {
        await alertAdmin(
          "Échec de prélèvement Stripe",
          `La facture Stripe ${invoice.id} a échoué (montant ${formatEUR(invoice.amount_due)}).`,
        );
        break;
      }
      return `${event.type}:${await handleStripePaymentFailed(invoice)}`;
    }
    case "invoice.payment_action_required": {
      const invoice = event.data.object as Stripe.Invoice;
      if (isZeroAmountInvoice(invoice) || !isSubscriptionInvoice(invoice)) break;
      return `${event.type}:${await handleStripeActionRequired(invoice)}`;
    }
    case "invoice.marked_uncollectible": {
      const invoice = event.data.object as Stripe.Invoice;
      return `${event.type}:${await handleStripeInvoiceUncollectible(invoice)}`;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const result = await syncSubscriptionFromStripe(await currentStripeSubscription(event.data.object as Stripe.Subscription));
      if (result) await notifySubscriptionSync(result);
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
          let deductionsCents = 0;
          const chargeTxs: Stripe.BalanceTransaction[] = [];
          for await (const tx of stripe.balanceTransactions.list({ payout: payout.id, limit: 100 })) {
            if (tx.type === "payout") continue;
            if (tx.type === "charge" || tx.type === "payment") chargeTxs.push(tx);
            // Remboursements, litiges, ajustements : retenus sur le versement (montant net négatif).
            else deductionsCents -= tx.net;
          }
          await prisma.stripePayout.update({ where: { id: row.id }, data: { deductionsCents } });
          for (const tx of chargeTxs) {
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
              // Montant cumulé côté Stripe : un 2e remboursement partiel ne s'additionne pas deux fois.
              refundedCents: charge.amount_refunded,
              notes: payment.notes?.includes("Remboursé Stripe")
                ? payment.notes
                : [payment.notes, "Remboursé Stripe"].filter(Boolean).join(" | "),
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
      await setDisputedCents(dispute, dispute.amount);
      await alertAdmin(
        "Litige Stripe",
        `Un litige a été ouvert (${dispute.id}) pour ${formatEUR(dispute.amount)}. Motif : ${dispute.reason}.`,
      );
      break;
    }
    case "charge.dispute.closed": {
      // Litige gagné : l'argent revient ; perdu : il reste retenu.
      const dispute = event.data.object as Stripe.Dispute;
      await setDisputedCents(dispute, dispute.status === "won" ? 0 : dispute.amount);
      break;
    }
    default:
      break;
  }
  return event.type;
}

/** Montant en litige sur le paiement du PaymentIntent du litige. */
async function setDisputedCents(dispute: Stripe.Dispute, cents: number): Promise<void> {
  const piId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!piId) return;
  await prisma.payment.updateMany({ where: { stripePaymentIntentId: piId }, data: { disputedCents: cents } });
}

const STUCK_AFTER_MS = 7 * 24 * 3_600_000;
const stuckAlertAt = new Map<string, number>();

/**
 * Prélèvement « en cours » depuis plus de 7 jours (webhook perdu) : le worker relit le paiement chez Stripe et applique
 * son issue comme le webhook l'aurait fait (réglé, ou refusé). Toujours en cours : rien. Introuvable : alerte, une par
 * document et par jour ; l'administrateur peut « Débloquer » (audit du 25/10/2026).
 */
export async function recheckStuckPaymentProcessing(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - STUCK_AFTER_MS);
  const [invoices, milestones] = await Promise.all([
    prisma.invoice.findMany({ where: { paymentProcessingAt: { lt: before } }, select: { id: true, number: true } }),
    prisma.paymentMilestone.findMany({
      where: { paymentProcessingAt: { lt: before }, status: { notIn: ["PAID", "CANCELLED"] } },
      select: { id: true, label: true, quote: { select: { number: true } } },
    }),
  ]);
  const targets = [
    ...invoices.map((i) => ({ key: "erpInvoiceId", id: i.id, label: `la facture ${i.number ?? i.id}` })),
    ...milestones.map((m) => ({ key: "erpMilestoneId", id: m.id, label: `l'échéance « ${m.label} » du devis ${m.quote.number ?? ""}`.trim() })),
  ];
  if (targets.length === 0) return 0;
  let resolved = 0;
  const stripe = await getStripe();
  for (const t of targets) {
    try {
      const found = await stripe.paymentIntents.search({ query: `metadata['${t.key}']:'${t.id}'`, limit: 10 });
      const pi = [...found.data].sort((a, b) => b.created - a.created)[0];
      if (!pi) {
        const last = stuckAlertAt.get(t.id) ?? 0;
        if (now.getTime() - last >= 24 * 3_600_000) {
          stuckAlertAt.set(t.id, now.getTime());
          const { alertAdmin } = await import("@/lib/stripe/alert.js");
          await alertAdmin(
            "Prélèvement en cours depuis plus de 7 jours",
            `Le prélèvement de ${t.label} est noté « en cours » depuis plus de 7 jours, et Stripe ne retrouve pas le paiement. Vérifiez dans Stripe, puis utilisez « Débloquer » sur la fiche pour le rendre à nouveau payable.`,
          ).catch(() => undefined);
        }
        continue;
      }
      if (pi.status === "succeeded") {
        await handleEvent({ type: "payment_intent.succeeded", data: { object: pi } } as Stripe.Event);
        resolved += 1;
      } else if (pi.status === "canceled" || pi.status === "requires_payment_method") {
        await handleEvent({ type: "payment_intent.payment_failed", data: { object: pi } } as Stripe.Event);
        resolved += 1;
      }
    } catch (err) {
      console.error(`[stripe] revérification du prélèvement en cours impossible (${t.key} ${t.id})`, err instanceof Error ? err.message : err);
    }
  }
  return resolved;
}
