import { InvoiceDocumentType, InvoiceStatus, QuoteStatus, SubscriptionStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { formatDateFr } from "@/lib/format-fr.js";
import { lineTotalCents } from "@/lib/money.js";
import { currentPeriodEndOf, normalizeInterval, remainingCommitmentPeriods } from "@/lib/subscriptions/subscription-service.js";

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

export { currentPeriodEndOf, remainingCommitmentPeriods };

/**
 * Prix d'une période au devis d'origine (figé à sa signature) : toutes ses lignes d'abonnement additionnées, comme à
 * l'activation (un devis récurrent forme un seul abonnement). Abonnement créé à la main : son montant.
 */
async function originalPeriodPriceCents(sub: { id: string; amountCents: number }): Promise<{ cents: number; quoteNumber: string | null; interval: string | null }> {
  const first = await prisma.invoiceLine.findFirst({
    where: { subscriptionId: sub.id, isSubscription: true, revisesSubscriptionId: null, invoice: { documentType: InvoiceDocumentType.QUOTE, number: { not: null } } },
    orderBy: { invoice: { issueDate: "asc" } },
    select: { invoiceId: true, billingInterval: true, invoice: { select: { number: true } } },
  });
  if (!first) return { cents: sub.amountCents, quoteNumber: null, interval: null };
  const lines = await prisma.invoiceLine.findMany({
    where: { invoiceId: first.invoiceId, subscriptionId: sub.id, isSubscription: true, revisesSubscriptionId: null },
    select: { unitPriceCents: true },
  });
  return { cents: lines.reduce((sum, l) => sum + l.unitPriceCents, 0), quoteNumber: first.invoice.number, interval: first.billingInterval };
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
  // Avenant qui a changé la périodicité : le prix par période du devis d'origine ne s'applique plus.
  const intervalChanged = Boolean(price?.interval) && normalizeInterval(price!.interval) !== normalizeInterval(sub.billingInterval);
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
            : intervalChanged
              ? "La périodicité de l'abonnement a changé par avenant : le prix par période du devis d'origine ne s'applique plus. Établissez le rachat à la main."
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
  // Double clic : les demandes d'un même abonnement passent l'une après l'autre ; la seconde voit le devis de la
  // première et reçoit le 409 « déjà en cours ». Une seule instance de l'API crée ces devis.
  const previous = buyoutLocks.get(subscriptionId) ?? Promise.resolve();
  const run = previous.then(() => createBuyoutQuoteNow(subscriptionId, now));
  const settled = run.then(() => undefined, () => undefined);
  buyoutLocks.set(subscriptionId, settled);
  void settled.then(() => {
    if (buyoutLocks.get(subscriptionId) === settled) buyoutLocks.delete(subscriptionId);
  });
  return run;
}

const buyoutLocks = new Map<string, Promise<void>>();

async function createBuyoutQuoteNow(subscriptionId: string, now: Date) {
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
      // Fin de période figée : les lignes en dépendent ; la signature est refusée si elle a changé (audit du 25/10/2026).
      buyoutPeriodEndsAt: state.periodEndsAt,
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

/**
 * Rappel de fin du premier engagement (R3) : prix de rachat annoncé, le même calcul que le devis de rachat créé ce jour
 * (tarif plein du catalogue, plus les échéances restant à courir jusqu'à la fin de l'engagement, audit du 28/10/2026) ;
 * null sans prestation active ou après un rachat signé.
 */
export async function buyoutOfferPriceCents(subscriptionId: string, now = new Date()): Promise<number | null> {
  const state = await buyoutStateOf(subscriptionId, now);
  if (!state?.service.active || state.signed) return null;
  return state.service.unitPriceCents + (state.remaining ? lineTotalCents(state.remaining.count, state.remaining.unitPriceCents) : 0);
}

type Tx = Prisma.TransactionClient;
export type BuyoutSignature = { subscriptionId: string; endDate: Date; stripe: { id: string; livemode: boolean | null } | null };

/**
 * Signature d'un devis de rachat : vérifie seulement que la période n'a pas changé depuis le devis. L'abonnement ne
 * s'arrête plus à la signature, mais au paiement du prix du rachat (décision d'Alexandre du 28/10/2026, CGV « Une fois
 * le prix du rachat payé […] l'abonnement prend fin ») : applyPaidBuyouts. Renvoie toujours null (rien à finir).
 */
export async function applyBuyoutSignature(tx: Tx, quoteId: string, now = new Date()): Promise<BuyoutSignature | null> {
  const quote = await tx.invoice.findUnique({ where: { id: quoteId }, select: { documentType: true, buysOutSubscriptionId: true, buyoutPeriodEndsAt: true } });
  if (quote?.documentType !== InvoiceDocumentType.QUOTE || !quote.buysOutSubscriptionId) return null;
  const sub = await tx.subscription.findUnique({
    where: { id: quote.buysOutSubscriptionId },
    select: { id: true, status: true, nextInvoiceAt: true, billingInterval: true },
  });
  if (!sub || sub.status === SubscriptionStatus.ENDED) return null;
  const periodEnd = currentPeriodEndOf(sub, now);
  // Période changée depuis le devis : ses lignes (périodes restantes) ne correspondent plus, la période en cours serait
  // payée deux fois. Devis créé avant la migration (fin non figée) : comportement d'avant.
  if (quote.buyoutPeriodEndsAt && quote.buyoutPeriodEndsAt.getTime() !== periodEnd.getTime()) {
    const { QuoteDecisionError } = await import("@/lib/invoices/transitions.js");
    throw new QuoteDecisionError(
      "La période de l'abonnement a changé depuis ce devis de rachat : un nouveau devis de rachat est nécessaire.",
      "EXPIRED",
    );
  }
  return null;
}

/** Prix du rachat payé : le devis a des factures, toutes réglées, qui couvrent son total. */
async function buyoutPricePaid(quote: { id: string; totalCents: number }): Promise<boolean> {
  const invoices = await prisma.invoice.findMany({
    where: { OR: [{ quoteId: quote.id }, { sourceQuoteId: quote.id }], documentType: InvoiceDocumentType.INVOICE, status: { not: InvoiceStatus.CANCELLED } },
    select: { status: true, totalCents: true },
  });
  return invoices.length > 0 && invoices.every((i) => i.status === InvoiceStatus.PAID) && invoices.reduce((s, i) => s + i.totalCents, 0) >= quote.totalCents;
}

/**
 * Rachat payé (décision du 28/10/2026) : l'abonnement prend fin à la fin de la période en cours au paiement, sans
 * nouvelle échéance (endDate au dernier instant de la période), puis le prélèvement Stripe est arrêté à la fin de sa
 * période (finishBuyoutSignature). Une fin déjà programmée est gardée. Appelé après chaque paiement et par le worker ;
 * idempotent. Paiement venu après la fin de période figée sur le devis : une période de plus a pu être facturée, alerte.
 * @returns nombre d'abonnements dont la fin vient d'être posée.
 */
export async function applyPaidBuyouts(now = new Date()): Promise<number> {
  const quotes = await prisma.invoice.findMany({
    where: { documentType: InvoiceDocumentType.QUOTE, quoteStatus: QuoteStatus.ACCEPTED, buysOutSubscriptionId: { not: null } },
    select: { id: true, number: true, totalCents: true, buysOutSubscriptionId: true, buyoutPeriodEndsAt: true },
  });
  let applied = 0;
  for (const q of quotes) {
    const sub = await prisma.subscription.findUnique({
      where: { id: q.buysOutSubscriptionId! },
      select: { id: true, label: true, status: true, endDate: true, nextInvoiceAt: true, billingInterval: true, stripeSubscriptionId: true, stripeLivemode: true },
    });
    if (!sub || sub.status === SubscriptionStatus.ENDED || sub.endDate) continue;
    if (!(await buyoutPricePaid(q))) continue;
    const periodEnd = currentPeriodEndOf(sub, now);
    const endDate = new Date(periodEnd.getTime() - 1);
    const done = await prisma.subscription.updateMany({ where: { id: sub.id, endDate: null }, data: { endDate } });
    if (done.count !== 1) continue;
    applied += 1;
    await finishBuyoutSignature({ subscriptionId: sub.id, endDate, stripe: sub.stripeSubscriptionId ? { id: sub.stripeSubscriptionId, livemode: sub.stripeLivemode } : null });
    if (q.buyoutPeriodEndsAt && periodEnd.getTime() > q.buyoutPeriodEndsAt.getTime()) {
      const { alertAdmin } = await import("@/lib/stripe/alert.js");
      await alertAdmin(
        `Rachat payé après la période prévue : « ${sub.label} »`,
        `Le rachat (devis ${q.number ?? q.id}) est payé après le ${formatDateFr(q.buyoutPeriodEndsAt)}, fin de période prévue par le devis : l'abonnement prend fin le ${formatDateFr(periodEnd)}. ` +
          "Une échéance a pu être facturée en plus des échéances restantes du devis : vérifiez et faites un avoir si besoin.",
      ).catch(() => undefined);
    }
  }
  return applied;
}

/** Après un paiement : applique un rachat devenu payé, sans jamais faire échouer l'enregistrement du paiement. */
export async function applyPaidBuyoutsSafely(): Promise<void> {
  try {
    await applyPaidBuyouts();
  } catch (err) {
    console.error("[rachat] fin de l'abonnement après paiement du rachat non appliquée (reprise par le worker)", err);
  }
}

/** Après le paiement du rachat : prélèvement Stripe arrêté à la fin de sa période. Un échec ne défait rien : alerte. */
export async function finishBuyoutSignature(signature: BuyoutSignature | null): Promise<void> {
  if (!signature) return;
  // Avis de reconduction ou de fin de période encore en attente de validation : sans objet après un rachat.
  const { rejectObsoleteReviewEmails, SUBSCRIPTION_NOTICE_KINDS } = await import("@/lib/email/review.js");
  await rejectObsoleteReviewEmails(signature.subscriptionId, SUBSCRIPTION_NOTICE_KINDS, "Rachat payé : avis d'abonnement sans objet.");
  if (!signature.stripe) return;
  try {
    const { applyStripeSubscriptionAction } = await import("@/lib/stripe/subscription-control.js");
    await applyStripeSubscriptionAction(signature.stripe.id, "endAtPeriodEnd", signature.stripe.livemode);
  } catch (err) {
    const { alertAdmin } = await import("@/lib/stripe/alert.js");
    await alertAdmin(
      "Rachat payé : prélèvement Stripe à arrêter",
      `Le rachat est payé, mais Stripe n'a pas programmé la fin du prélèvement (${err instanceof Error ? err.message : "erreur inconnue"}). Programmez la fin à la fin de la période en cours dans Stripe, sinon le client sera prélevé de nouveau.`,
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
