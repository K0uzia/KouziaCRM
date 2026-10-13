import { prisma } from "@/lib/prisma.js";
import { monthBounds, monthLabelFr } from "@/lib/finance/dates.js";

/**
 * Rapprochement Stripe, sans banque connectée : à partir des paiements (frais, remboursements,
 * litiges) et des versements Stripe déjà synchronisés.
 */

export type FluxMonth = {
  /** AAAA-MM */
  key: string;
  label: string;
  /** CA encaissé du mois (tous paiements, le même chiffre que le tableau de bord). */
  caCents: number;
  /** Encaissé par Stripe (carte, prélèvement), brut. */
  encaisseStripeCents: number;
  /** Arrivé directement sur le compte pro (virement, chèque, espèces). */
  directCents: number;
  feeCents: number;
  /** Paiements Stripe dont les frais ne sont pas encore connus. */
  unknownFeeCount: number;
  refundsDisputesCents: number;
  /** Net des paiements du mois déjà inclus dans un versement vers le compte pro. */
  verseCents: number;
  /** Net des paiements du mois encore chez Stripe (prochain versement). */
  pendingCents: number;
  /** Somme des écarts des versements arrivés dans le mois (0 si tout est rapproché). */
  gapCents: number;
};

export type FluxPayout = {
  id: string;
  stripePayoutId: string;
  amountCents: number;
  arrivalDate: Date | null;
  status: string;
  grossCents: number;
  feeCents: number;
  deductionsCents: number;
  /** Brut des paiements − frais − retenues : ce que Stripe aurait dû virer. */
  expectedCents: number;
  /** Viré − attendu ; null tant que le versement n'est pas arrivé (paiements reliés à l'arrivée). */
  gapCents: number | null;
  payments: Array<{
    id: string;
    amountCents: number;
    feeCents: number | null;
    paidAt: Date;
    method: string;
    invoice: { id: string; number: string | null; client: { displayName: string } } | null;
  }>;
};

const FAILED = new Set(["failed", "canceled"]);
const keyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const boundsOf = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  return monthBounds(y, m);
};

async function loadAll() {
  const [payments, payouts] = await Promise.all([
    prisma.payment.findMany({
      select: {
        id: true,
        amountCents: true,
        paidAt: true,
        method: true,
        stripePaymentIntentId: true,
        feeCents: true,
        refundedCents: true,
        disputedCents: true,
        stripePayoutId: true,
        stripePayout: { select: { status: true } },
        invoice: { select: { id: true, number: true, client: { select: { displayName: true } } } },
      },
    }),
    prisma.stripePayout.findMany({ orderBy: [{ arrivalDate: "desc" }, { createdAt: "desc" }] }),
  ]);
  return { payments, payouts };
}

type Loaded = Awaited<ReturnType<typeof loadAll>>;

function payoutView(p: Loaded["payouts"][number], payments: Loaded["payments"]): FluxPayout {
  const linked = payments.filter((x) => x.stripePayoutId === p.id);
  const grossCents = linked.reduce((s, x) => s + x.amountCents, 0);
  const feeCents = linked.reduce((s, x) => s + (x.feeCents ?? 0), 0);
  const deductionsCents = p.deductionsCents ?? 0;
  const expectedCents = grossCents - feeCents - deductionsCents;
  return {
    id: p.id,
    stripePayoutId: p.stripePayoutId,
    amountCents: p.amountCents,
    arrivalDate: p.arrivalDate,
    status: p.status,
    grossCents,
    feeCents,
    deductionsCents,
    expectedCents,
    // Les paiements sont reliés à l'arrivée (payout.paid) : avant, aucun écart n'a de sens.
    gapCents: p.status === "paid" ? p.amountCents - expectedCents : null,
    payments: linked
      .sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime())
      .map((x) => ({ id: x.id, amountCents: x.amountCents, feeCents: x.feeCents, paidAt: x.paidAt, method: x.method, invoice: x.invoice })),
  };
}

function monthView(key: string, { payments, payouts }: Loaded): FluxMonth {
  const b = boundsOf(key);
  const inMonth = (d: Date | null) => Boolean(d) && d!.getTime() >= b.start.getTime() && d!.getTime() <= b.end.getTime();
  const ofMonth = payments.filter((p) => inMonth(p.paidAt));
  const stripe = ofMonth.filter((p) => p.stripePaymentIntentId && p.amountCents > 0);
  const net = (p: (typeof stripe)[number]) => p.amountCents - (p.feeCents ?? 0) - p.refundedCents - p.disputedCents;
  const paidOut = (p: (typeof stripe)[number]) => Boolean(p.stripePayoutId) && !FAILED.has(p.stripePayout?.status ?? "");
  const caCents = ofMonth.reduce((s, p) => s + p.amountCents, 0);
  const encaisseStripeCents = stripe.reduce((s, p) => s + p.amountCents, 0);
  const arrived = payouts.filter((p) => p.status === "paid" && inMonth(p.arrivalDate ?? p.createdAt));
  return {
    key,
    label: monthLabelFr(b.year, b.month),
    caCents,
    encaisseStripeCents,
    directCents: caCents - encaisseStripeCents,
    feeCents: stripe.reduce((s, p) => s + (p.feeCents ?? 0), 0),
    unknownFeeCount: stripe.filter((p) => p.feeCents === null).length,
    refundsDisputesCents: stripe.reduce((s, p) => s + p.refundedCents + p.disputedCents, 0),
    verseCents: stripe.filter(paidOut).reduce((s, p) => s + net(p), 0),
    pendingCents: stripe.filter((p) => !paidOut(p)).reduce((s, p) => s + net(p), 0),
    gapCents: arrived.reduce((s, p) => s + (payoutView(p, payments).gapCents ?? 0), 0),
  };
}

/** Mois ayant un paiement ou un versement, du plus récent au plus ancien, mois courant compris. */
function monthKeys({ payments, payouts }: Loaded, now: Date): string[] {
  const dates = [...payments.map((p) => p.paidAt), ...payouts.map((p) => p.arrivalDate ?? p.createdAt)];
  const first = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : now;
  const keys: string[] = [];
  for (let d = new Date(now.getFullYear(), now.getMonth(), 1); d >= new Date(first.getFullYear(), first.getMonth(), 1); d.setMonth(d.getMonth() - 1)) {
    keys.push(keyOf(d));
  }
  return keys;
}

export async function getStripeFlux(monthKey: string | undefined, now: Date = new Date()) {
  const data = await loadAll();
  const months = monthKeys(data, now);
  const key = monthKey && months.includes(monthKey) ? monthKey : months[0]!;
  const b = boundsOf(key);
  const inMonth = (d: Date) => d.getTime() >= b.start.getTime() && d.getTime() <= b.end.getTime();
  const payouts = data.payouts
    .filter((p) => inMonth(p.arrivalDate ?? p.createdAt))
    .map((p) => payoutView(p, data.payments));
  // Graphique « Chemin Stripe » : 12 derniers mois, du plus ancien au plus récent.
  const series = months.slice(0, 12).reverse().map((k) => monthView(k, data));
  return { months, month: monthView(key, data), payouts, series };
}
