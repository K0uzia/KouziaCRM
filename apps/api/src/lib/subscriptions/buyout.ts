import { InvoiceDocumentType, QuoteStatus, SubscriptionStatus } from "@prisma/client";
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
  const blocked =
    sub.status !== SubscriptionStatus.ACTIVE
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
    remaining: remaining.count > 0 ? { count: remaining.count, unitPriceCents: price!.cents, until: remaining.until, label: remainingLabel(sub.billingInterval) } : null,
    quotes,
    canPropose: blocked === null,
    blockedReason: blocked,
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
