import { InvoiceDocumentType, QuoteStatus, SubscriptionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { formatDateFr } from "@/lib/format-fr.js";
import { lineTotalCents } from "@/lib/money.js";
import { commitmentEndOf } from "@/lib/subscriptions/commitment.js";
import { normalizeInterval, periodMonths } from "@/lib/subscriptions/subscription-service.js";

/**
 * Rachat du site (lots R1 à R3, décisions du 24/10/2026). L'offre d'abonnement porte sa prestation de rachat (catalogue,
 * prix fixé par Alexandre). « Proposer le rachat » crée un devis brouillon en paiement unique : le prix de rachat et, avant
 * la fin de l'engagement, les périodes restantes au prix figé du devis d'origine. L'abonnement s'arrête toujours à la fin
 * de la période en cours (R2).
 */

export class BuyoutError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly quoteId: string | null = null,
  ) {
    super(message);
  }
}

/** Devis de rachat encore valable ou signé : on n'en propose pas un second. */
const LIVE_QUOTE_STATUSES: readonly QuoteStatus[] = [QuoteStatus.DRAFT, QuoteStatus.SENT, QuoteStatus.ACCEPTED];

type PeriodSub = { nextInvoiceAt: Date; billingInterval: string | null; commitmentEndsAt: Date | null };

/** Fin de la période de facturation en cours : la prochaine échéance, avancée d'une période tant qu'elle est passée. */
export function currentPeriodEndOf(sub: PeriodSub, now = new Date()): Date {
  const months = periodMonths(sub.billingInterval);
  let end = new Date(sub.nextInvoiceAt);
  while (end.getTime() <= now.getTime()) end = commitmentEndOf(end, months);
  return end;
}

/** Périodes de l'engagement qui commencent après la période en cours (0 une fois l'engagement atteint). */
export function remainingCommitmentPeriods(sub: PeriodSub, now = new Date()): { count: number; from: Date; until: Date | null } {
  const from = currentPeriodEndOf(sub, now);
  if (!sub.commitmentEndsAt) return { count: 0, from, until: null };
  const months = periodMonths(sub.billingInterval);
  let count = 0;
  for (let start = from; start.getTime() < sub.commitmentEndsAt.getTime(); start = commitmentEndOf(start, months)) count += 1;
  return { count, from, until: sub.commitmentEndsAt };
}

/** Prix d'une période au devis d'origine (figé à sa signature) ; abonnement créé à la main : son montant. */
async function originalPeriodPriceCents(sub: { id: string; amountCents: number }): Promise<{ cents: number; quoteNumber: string | null }> {
  const line = await prisma.invoiceLine.findFirst({
    where: { subscriptionId: sub.id, isSubscription: true, invoice: { documentType: InvoiceDocumentType.QUOTE, number: { not: null } } },
    orderBy: { invoice: { issueDate: "asc" } },
    select: { unitPriceCents: true, invoice: { select: { number: true } } },
  });
  return line ? { cents: line.unitPriceCents, quoteNumber: line.invoice.number } : { cents: sub.amountCents, quoteNumber: null };
}

const remainingLabel = (interval: string | null) =>
  normalizeInterval(interval) === "YEAR" ? "Annuités restantes de l'engagement" : "Échéances restantes de l'engagement";

/** État du rachat d'un abonnement, pour sa fiche. null : l'offre n'a pas de prestation de rachat. */
export async function buyoutStateOf(subscriptionId: string, now = new Date()) {
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      label: true,
      status: true,
      amountCents: true,
      nextInvoiceAt: true,
      billingInterval: true,
      commitmentEndsAt: true,
      endDate: true,
      transferredAt: true,
      service: { select: { buyoutServiceId: true } },
    },
  });
  if (!sub?.service.buyoutServiceId) return null;
  const service = await prisma.service.findUnique({
    where: { id: sub.service.buyoutServiceId },
    select: { id: true, name: true, unitPriceCents: true, active: true },
  });
  if (!service) return null;
  const quotes = await prisma.invoice.findMany({
    where: { buysOutSubscriptionId: sub.id, documentType: InvoiceDocumentType.QUOTE },
    select: { id: true, number: true, quoteStatus: true, totalCents: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const remaining = remainingCommitmentPeriods(sub, now);
  const price = remaining.count > 0 ? await originalPeriodPriceCents(sub) : null;
  const live = quotes.find((q) => q.quoteStatus && LIVE_QUOTE_STATUSES.includes(q.quoteStatus));
  const signed = quotes.some((q) => q.quoteStatus === QuoteStatus.ACCEPTED);
  // Rachat signé : la fiche montre la fin de l'abonnement et le suivi du transfert, plus les périodes restantes.
  const blocked = signed
    ? "Rachat signé."
    : sub.status !== SubscriptionStatus.ACTIVE
      ? "Seul un abonnement actif peut être racheté."
      : !sub.commitmentEndsAt
        ? "Pas de rachat sans engagement."
        : !service.active
          ? "La prestation de rachat de l'offre est archivée."
          : live
            ? "Un devis de rachat est déjà en cours pour cet abonnement."
            : null;
  return {
    service,
    periodEndsAt: remaining.from,
    remaining: !signed && remaining.count > 0 ? { count: remaining.count, unitPriceCents: price!.cents, until: remaining.until, label: remainingLabel(sub.billingInterval) } : null,
    quotes,
    canPropose: blocked === null,
    blockedReason: blocked,
    // R2 : rachat signé, fin programmée (dernier instant de la période) et suivi du transfert du site.
    signed,
    endsAt: sub.endDate,
    transferredAt: sub.transferredAt,
  };
}

/**
 * Crée le devis de rachat (brouillon, paiement unique, modifiable avant émission) : le prix de rachat du catalogue et,
 * avant la fin de l'engagement, une ligne pour les périodes restantes. Le devis garde le lien vers l'abonnement racheté.
 */
export async function createBuyoutQuote(subscriptionId: string, now = new Date()) {
  const state = await buyoutStateOf(subscriptionId, now);
  if (!state) throw new BuyoutError("Cette offre n'a pas de prestation de rachat au catalogue.", 400);
  if (!state.canPropose) {
    const live = state.quotes.find((q) => q.quoteStatus && LIVE_QUOTE_STATUSES.includes(q.quoteStatus));
    throw new BuyoutError(state.blockedReason!, live ? 409 : 400, live?.id ?? null);
  }
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, select: { id: true, clientId: true, label: true } });
  const end = formatDateFr(state.periodEndsAt);
  const lines = [
    {
      position: 1,
      description: `${state.service.name} (abonnement « ${sub.label} », fin le ${end})`,
      quantity: 1,
      unitPriceCents: state.service.unitPriceCents,
      lineTotalCents: state.service.unitPriceCents,
      serviceId: state.service.id,
    },
    ...(state.remaining
      ? [
          {
            position: 2,
            description: `${state.remaining.label} (du ${end} au ${formatDateFr(state.remaining.until!)})`,
            quantity: state.remaining.count,
            unitPriceCents: state.remaining.unitPriceCents,
            lineTotalCents: lineTotalCents(state.remaining.count, state.remaining.unitPriceCents),
          },
        ]
      : []),
  ];
  const totalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const validUntil = new Date(now);
  validUntil.setDate(validUntil.getDate() + 30);
  return prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      quoteStatus: QuoteStatus.DRAFT,
      billingMode: "ONE_OFF",
      paymentPlanOffer: "ONE",
      clientId: sub.clientId,
      buysOutSubscriptionId: sub.id,
      paymentTerms: "Devis valable 30 jours",
      validUntil,
      subtotalCents: totalCents,
      totalCents,
      lines: { create: lines },
    },
    select: { id: true },
  });
}

/** Offre d'abonnement (prestation d'abonnement ou pack vendable en récurrent) et prestation de rachat valable. */
export async function assertBuyoutService(
  offer: { id?: string; isSubscription: boolean; isPack: boolean; annualPriceCents: number | null },
  buyoutServiceId: string | null,
): Promise<void> {
  if (buyoutServiceId === null) return;
  if (!offer.isSubscription && !(offer.isPack && offer.annualPriceCents !== null)) {
    throw new BuyoutError("Seule une offre d'abonnement a une prestation de rachat.");
  }
  if (offer.id && offer.id === buyoutServiceId) throw new BuyoutError("Une offre ne peut pas être sa propre prestation de rachat.");
  const target = await prisma.service.findUnique({
    where: { id: buyoutServiceId },
    select: { active: true, isSubscription: true, isPack: true },
  });
  if (!target) throw new BuyoutError("Prestation de rachat introuvable.", 404);
  if (!target.active) throw new BuyoutError("La prestation de rachat est archivée.");
  if (target.isSubscription || target.isPack) throw new BuyoutError("La prestation de rachat est une prestation ponctuelle du catalogue, pas un abonnement ni un pack.");
}

/** Rappel de fin du premier engagement (R3) : prix de rachat à proposer, ou null (pas de prestation active, rachat signé). */
export async function buyoutOfferPriceCents(subscriptionId: string): Promise<number | null> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { service: { select: { buyoutServiceId: true } } } });
  if (!sub?.service.buyoutServiceId) return null;
  const service = await prisma.service.findUnique({ where: { id: sub.service.buyoutServiceId }, select: { active: true, unitPriceCents: true } });
  if (!service?.active) return null;
  const signed = await prisma.invoice.count({
    where: { buysOutSubscriptionId: subscriptionId, documentType: InvoiceDocumentType.QUOTE, quoteStatus: QuoteStatus.ACCEPTED },
  });
  return signed ? null : service.unitPriceCents;
}

type Tx = Prisma.TransactionClient;
export type BuyoutSignature = { subscriptionId: string; endDate: Date; stripe: { id: string; livemode: boolean | null } | null };

/**
 * Signature d'un devis de rachat (R2, décision Q2) : l'abonnement prend fin à la fin de la période en cours, sans
 * nouvelle échéance (endDate au dernier instant de la période : ni facture, ni rappel ensuite). Une fin déjà plus
 * proche est gardée. Dans la transaction de la signature ; Stripe est prévenu après (finishBuyoutSignature).
 */
export async function applyBuyoutSignature(tx: Tx, quoteId: string, now = new Date()): Promise<BuyoutSignature | null> {
  const quote = await tx.invoice.findUnique({ where: { id: quoteId }, select: { documentType: true, buysOutSubscriptionId: true } });
  if (quote?.documentType !== InvoiceDocumentType.QUOTE || !quote.buysOutSubscriptionId) return null;
  const sub = await tx.subscription.findUnique({
    where: { id: quote.buysOutSubscriptionId },
    select: { id: true, status: true, endDate: true, nextInvoiceAt: true, billingInterval: true, commitmentEndsAt: true, stripeSubscriptionId: true, stripeLivemode: true },
  });
  if (!sub || sub.status === SubscriptionStatus.ENDED) return null;
  const lastInstant = new Date(currentPeriodEndOf(sub, now).getTime() - 1);
  const endDate = sub.endDate && sub.endDate < lastInstant ? sub.endDate : lastInstant;
  await tx.subscription.update({ where: { id: sub.id }, data: { endDate } });
  return { subscriptionId: sub.id, endDate, stripe: sub.stripeSubscriptionId ? { id: sub.stripeSubscriptionId, livemode: sub.stripeLivemode } : null };
}

/** Après la signature : prélèvement Stripe arrêté à la fin de sa période. Un échec ne défait pas la signature : alerte. */
export async function finishBuyoutSignature(signature: BuyoutSignature | null): Promise<void> {
  if (!signature?.stripe) return;
  try {
    const { applyStripeSubscriptionAction } = await import("@/lib/stripe/subscription-control.js");
    await applyStripeSubscriptionAction(signature.stripe.id, "endAtPeriodEnd", signature.stripe.livemode);
  } catch (err) {
    const { alertAdmin } = await import("@/lib/stripe/alert.js");
    await alertAdmin(
      "Rachat signé : prélèvement Stripe à arrêter",
      `Le devis de rachat est signé, mais Stripe n'a pas programmé la fin du prélèvement (${err instanceof Error ? err.message : "erreur inconnue"}). Programmez la fin à la fin de la période en cours dans Stripe, sinon le client sera prélevé de nouveau.`,
    ).catch(() => undefined);
  }
}

/** Worker : abonnement racheté dont la dernière période est terminée, passé à « Clôturé ». */
export async function closeBoughtOutSubscriptions(now = new Date()): Promise<number> {
  const signed = await prisma.invoice.findMany({
    where: { documentType: InvoiceDocumentType.QUOTE, quoteStatus: QuoteStatus.ACCEPTED, buysOutSubscriptionId: { not: null } },
    select: { buysOutSubscriptionId: true },
  });
  const ids = [...new Set(signed.map((q) => q.buysOutSubscriptionId!))];
  if (!ids.length) return 0;
  const closed = await prisma.subscription.updateMany({
    where: { id: { in: ids }, status: { not: SubscriptionStatus.ENDED }, endDate: { lt: now } },
    data: { status: SubscriptionStatus.ENDED },
  });
  return closed.count;
}

/** Suivi du transfert du site (hors ERP) : seulement après un rachat signé. null retire la date. */
export async function setTransferredAt(subscriptionId: string, at: Date | null) {
  const signed = await prisma.invoice.count({
    where: { buysOutSubscriptionId: subscriptionId, documentType: InvoiceDocumentType.QUOTE, quoteStatus: QuoteStatus.ACCEPTED },
  });
  if (!signed) throw new BuyoutError("Le transfert se note après la signature du devis de rachat.", 409);
  return prisma.subscription.update({ where: { id: subscriptionId }, data: { transferredAt: at }, select: { id: true, transferredAt: true } });
}
