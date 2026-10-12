import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { formatEUR } from "@/lib/money.js";
import { assertStripeEnabled, getStripe, getStripeConfig } from "@/lib/stripe/client.js";

export class PayoutError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** Délai annoncé pour un versement manuel en euros vers un compte SEPA. */
export const PAYOUT_DELAY_TEXT = "arrivée sous 1 à 3 jours ouvrés";

export type PayoutPreview = {
  availableCents: number;
  pendingCents: number;
  destination: { bankName: string | null; last4: string } | null;
  mode: "test" | "live";
  delayText: string;
};

function eurAmount(list: Array<{ amount: number; currency: string }>): number {
  return list.filter((b) => b.currency === "eur").reduce((s, b) => s + b.amount, 0);
}

/** Compte de destination : celui du dernier versement connu (Stripe ne l'expose pas autrement pour son propre compte). */
async function lastDestination(stripe: Stripe): Promise<PayoutPreview["destination"]> {
  try {
    const last = await stripe.payouts.list({ limit: 1, expand: ["data.destination"] });
    const dest = last.data[0]?.destination;
    if (dest && typeof dest !== "string" && dest.object === "bank_account" && !("deleted" in dest && dest.deleted)) {
      const bank = dest as Stripe.BankAccount;
      return { bankName: bank.bank_name ?? null, last4: bank.last4 };
    }
  } catch {
    /* information facultative */
  }
  return null;
}

/** Solde disponible et informations de la fenêtre « Verser ». */
export async function getPayoutPreview(): Promise<PayoutPreview> {
  await assertStripeEnabled();
  const { mode } = await getStripeConfig();
  const stripe = await getStripe();
  const balance = await stripe.balance.retrieve();
  return {
    availableCents: eurAmount(balance.available),
    pendingCents: eurAmount(balance.pending),
    destination: await lastDestination(stripe),
    mode,
    delayText: PAYOUT_DELAY_TEXT,
  };
}

/**
 * Versement manuel du solde Stripe vers le compte bancaire. Idempotent par requestId (un double clic
 * ou un renvoi réseau ne crée jamais deux versements) ; plafonné au solde DISPONIBLE.
 */
export async function createManualPayout(opts: {
  amountCents: number;
  requestId: string;
  actorEmail: string | null;
}): Promise<{ stripePayoutId: string; status: string; amountCents: number }> {
  await assertStripeEnabled();
  const { mode } = await getStripeConfig();
  if (process.env.NODE_ENV === "production" && mode === "test") {
    throw new PayoutError("Clé Stripe de test en production : versement refusé.", 409);
  }
  if (!Number.isInteger(opts.amountCents) || opts.amountCents <= 0) {
    throw new PayoutError("Montant invalide.", 400);
  }

  const stripe = await getStripe();
  const balance = await stripe.balance.retrieve();
  const available = eurAmount(balance.available);
  if (opts.amountCents > available) {
    throw new PayoutError(`Montant supérieur au solde disponible (${formatEUR(available)}).`, 409);
  }

  let payout: Stripe.Payout;
  try {
    payout = await stripe.payouts.create(
      {
        amount: opts.amountCents,
        currency: "eur",
        description: "Kouzia ERP",
        statement_descriptor: "KOUZIA ERP",
        metadata: { source: "kouzia-erp", requestId: opts.requestId, requestedBy: opts.actorEmail ?? "" },
      },
      { idempotencyKey: `kouzia-payout-${opts.requestId}` },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Versement refusé par Stripe";
    throw new PayoutError(`Stripe a refusé le versement : ${message}`, 502);
  }

  await prisma.stripePayout.upsert({
    where: { stripePayoutId: payout.id },
    create: {
      stripePayoutId: payout.id,
      amountCents: payout.amount,
      arrivalDate: payout.arrival_date ? new Date(payout.arrival_date * 1000) : null,
      status: payout.status,
      requestedByEmail: opts.actorEmail,
      requestedAt: new Date(),
    },
    // Le webhook payout.* peut avoir créé la ligne avant : l'auteur de la demande est complété.
    update: { requestedByEmail: opts.actorEmail, requestedAt: new Date() },
  });
  return { stripePayoutId: payout.id, status: payout.status, amountCents: payout.amount };
}
