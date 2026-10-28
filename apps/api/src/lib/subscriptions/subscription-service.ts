import { cancellableTermOf, commitmentEndOf, isCommitmentMonths, renewalNoticeOf } from "@/lib/subscriptions/commitment.js";
import { discountCentsPerPeriod } from "@/lib/quotes/recurring-discount.js";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  QuoteStatus,
  SubscriptionCollectionMethod,
  SubscriptionStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { archiveIssuedDocument } from "@/lib/pdf/issued-archive.js";
import { issueInvoiceWithin, issueQuote } from "@/lib/invoices/transitions.js";
import { sendDocumentPdf } from "@/lib/email/send-document-pdf.js";
import { getCompanySettings } from "@/lib/company.js";
import { applyStripeSubscriptionAction } from "@/lib/stripe/subscription-control.js";
import { billedSubscriptionIds } from "@/lib/subscriptions/renewal-reminder.js";
import { formatDateFr } from "@/lib/format-fr.js";
import { rejectObsoleteReviewEmails, SUBSCRIPTION_NOTICE_KINDS } from "@/lib/email/review.js";

/** Périodicité d'un abonnement ; null en base vaut MONTH. QUARTER : trimestriel (mode récurrent, 24/10/2026). */
export type BillingInterval = "MONTH" | "QUARTER" | "YEAR";

export function normalizeInterval(value: string | null | undefined): BillingInterval {
  return value === "YEAR" || value === "QUARTER" ? value : "MONTH";
}

/** Mot de la période dans « 375 € par trimestre ». */
export function periodWord(interval: string | null | undefined): "an" | "trimestre" | "mois" {
  const iv = normalizeInterval(interval);
  return iv === "YEAR" ? "an" : iv === "QUARTER" ? "trimestre" : "mois";
}

/** Nombre de mois couverts par une échéance. */
export function periodMonths(interval: string | null | undefined): number {
  const iv = normalizeInterval(interval);
  return iv === "YEAR" ? 12 : iv === "QUARTER" ? 3 : 1;
}

/** Équivalent mensuel d'une échéance (MRR) : un montant annuel compte pour 1/12. */
export function monthlyEquivalentCents(amountCents: number, interval: string | null | undefined): number {
  return Math.round(amountCents / periodMonths(interval));
}

export type CreateSubscriptionInput = {
  clientId: string;
  serviceId: string;
  label: string;
  amountCents: number;
  billingDay: number;
  /** Montant par échéance : par mois (MONTH) ou par an (YEAR). Défaut MONTH. */
  billingInterval?: BillingInterval;
  startDate: Date;
  endDate?: Date | null;
  /** Si true : 1ʳᵉ échéance déjà facturée (devis) → nextInvoiceAt = période suivante */
  skipCurrentPeriod?: boolean;
  /** Si true : 1ʳᵉ échéance due tout de suite (devis d'abonnement seul) → nextInvoiceAt = startDate */
  firstPeriodNow?: boolean;
  /** STRIPE : prélèvement attendu, le cron ERP ne facture pas (les factures viendront de Stripe). */
  collectionMethod?: SubscriptionCollectionMethod;
  /**
   * 1re échéance différée (ex. une année offerte) : date de la 1re facture ou du 1er prélèvement, après le
   * début du contrat. Stripe la reprend en fin d'essai (trial_end = nextInvoiceAt).
   */
  firstInvoiceAt?: Date | null;
  /** Durée d'engagement en mois (12, 24, 36). Absent : sans engagement. */
  commitmentMonths?: number | null;
  /** Début de l'engagement (signature du devis) ; absent : startDate. Fin = début + durée. */
  commitmentStart?: Date | null;
  /**
   * Début dans le passé : true facture chaque période passée (rattrapage voulu). Par défaut, la 1re échéance est la
   * prochaine à partir d'aujourd'hui, jamais une facture antidatée par période passée.
   */
  catchUpPastPeriods?: boolean;
};

export class SubscriptionError extends Error {}

/** Client Prisma ou client de transaction : permet d'activer un abonnement dans la transaction d'émission. */
export type Db = Prisma.TransactionClient;

function validateBillingDay(day: number): void {
  if (!Number.isInteger(day) || day < 1 || day > 28) {
    throw new SubscriptionError("billingDay doit être un entier entre 1 et 28");
  }
}

function validateAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new SubscriptionError("amountCents doit être un entier positif");
  }
}

/** Date à minuit (heure locale du serveur), comme les échéances calculées. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** 1re échéance différée : au plus tôt le jour du début, jamais dans le passé. */
function validateFirstInvoiceAt(firstInvoiceAt: Date, startDate: Date): Date {
  if (Number.isNaN(firstInvoiceAt.getTime())) throw new SubscriptionError("Date de 1re facture invalide");
  const day = startOfDay(firstInvoiceAt);
  if (day < startOfDay(startDate)) throw new SubscriptionError("La 1re facture ne peut pas précéder le début de l'abonnement");
  if (day < startOfDay(new Date())) throw new SubscriptionError("La 1re facture ne peut pas être dans le passé");
  return day;
}

/** Prochaine date d'échéance >= today, au billingDay du mois. */
export function computeNextInvoiceAt(
  billingDay: number,
  from: Date = new Date(),
): Date {
  const out = new Date(from.getFullYear(), from.getMonth(), billingDay, 0, 0, 0, 0);
  if (out < from) {
    out.setMonth(out.getMonth() + 1);
  }
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function fmtDay(d: Date): string {
  return formatDateFr(d);
}

/**
 * Échéance suivante, bornée au dernier jour du mois (31 janvier + 1 mois = 28 ou 29 février, jamais 3 mars) et
 * ancrée sur le jour d'origine : après un 28 février, l'échéance revient au 31 mars (audit du 25/10/2026).
 */
export function nextPeriodDate(from: Date, months: number, anchorDay = from.getDate()): Date {
  const out = new Date(from);
  out.setDate(1);
  out.setMonth(out.getMonth() + months);
  const last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
  out.setDate(Math.min(anchorDay, last));
  return out;
}

/** Jour d'ancrage des échéances : celui de l'échéance, ou celui du début s'il est plus tardif en fin de mois. */
function anchorDayOf(sub: { nextInvoiceAt: Date; startDate: Date }): number {
  const day = sub.nextInvoiceAt.getDate();
  const start = sub.startDate.getDate();
  return day >= 28 && start > day ? start : day;
}

export async function createSubscription(
  data: CreateSubscriptionInput,
  db: Db = prisma,
) {
  validateBillingDay(data.billingDay);
  validateAmount(data.amountCents);

  const client = await db.client.findUnique({ where: { id: data.clientId } });
  if (!client) throw new SubscriptionError("Client introuvable");

  const service = await db.service.findUnique({ where: { id: data.serviceId } });
  if (!service) throw new SubscriptionError("Service introuvable");

  // Plusieurs abonnements actifs par client (ex. maintenance mensuelle et e-mails annuels) : chacun a son
  // début, sa périodicité et son encaissement, et est facturé séparément.
  const startDate = data.startDate ?? new Date();
  const billingInterval = normalizeInterval(data.billingInterval);
  let nextInvoiceAt = computeNextInvoiceAt(data.billingDay, startDate);
  if (data.firstInvoiceAt) {
    nextInvoiceAt = validateFirstInvoiceAt(data.firstInvoiceAt, startDate);
  } else if (data.firstPeriodNow) {
    nextInvoiceAt = startDate;
  } else if (data.skipCurrentPeriod) {
    // Période suivante au billingDay (1ʳᵉ échéance déjà dans le devis/facture)
    nextInvoiceAt = new Date(
      startDate.getFullYear(),
      startDate.getMonth() + periodMonths(billingInterval),
      data.billingDay,
      0,
      0,
      0,
      0,
    );
  }
  if (!data.firstInvoiceAt && !data.catchUpPastPeriods) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (data.firstPeriodNow) {
      if (nextInvoiceAt < today) nextInvoiceAt = new Date();
    } else {
      const anchor = nextInvoiceAt.getDate();
      while (nextInvoiceAt < today) nextInvoiceAt = nextPeriodDate(nextInvoiceAt, periodMonths(billingInterval), anchor);
    }
  }

  return db.subscription.create({
    data: {
      clientId: data.clientId,
      serviceId: data.serviceId,
      label: data.label,
      amountCents: data.amountCents,
      billingDay: data.billingDay,
      billingInterval,
      startDate,
      endDate: data.endDate ?? null,
      ...(isCommitmentMonths(data.commitmentMonths)
        ? {
            commitmentMonths: data.commitmentMonths,
            commitmentEndsAt: commitmentEndOf(data.commitmentStart ?? startDate, data.commitmentMonths),
          }
        : {}),
      status: SubscriptionStatus.ACTIVE,
      nextInvoiceAt,
      ...(data.collectionMethod ? { collectionMethod: data.collectionMethod } : {}),
    },
    include: { client: true, service: true },
  });
}

/**
 * 1re facture encore à venir : rien de facturé (ni par l'échéancier, ni par Stripe, ni par la facture du devis)
 * et 1re échéance dans le futur. Exclu du revenu récurrent, compté à part.
 */
async function pendingFirstInvoiceIds(subs: Array<{ id: string; lastInvoiceId: string | null; nextInvoiceAt: Date }>, now: Date) {
  const billed = await billedSubscriptionIds(subs);
  return new Set(subs.filter((s) => !billed.has(s.id) && s.nextInvoiceAt > now).map((s) => s.id));
}

/** Contrat verrouillé : la suppression ou le changement direct de montant est refusé (409). */
export class SubscriptionLockedError extends SubscriptionError {}

const DRAFT_COUNTS = { invoices: true, sourceLines: true, revisionLines: true } as const;
type DraftProbe = {
  stripeSubscriptionId: string | null;
  lastInvoiceId: string | null;
  _count: { invoices: number; sourceLines: number; revisionLines: number };
};
/**
 * Contrat corrigeable comme un brouillon : créé à la main (aucune ligne de devis ou d'avenant liée), jamais facturé,
 * sans prélèvement Stripe. Seul ce cas se supprime ou change de montant directement ; sinon : avenant ou clôture.
 */
const isDraftLike = (s: DraftProbe) =>
  !s.stripeSubscriptionId && !s.lastInvoiceId && s._count.invoices === 0 && s._count.sourceLines === 0 && s._count.revisionLines === 0;

async function assertDraftLike(id: string, message: string, db: Db = prisma) {
  const sub = await db.subscription.findUnique({ where: { id }, include: { _count: { select: DRAFT_COUNTS } } });
  if (!sub) throw new SubscriptionError("Abonnement introuvable");
  if (!isDraftLike(sub)) throw new SubscriptionLockedError(message);
  return sub;
}

export async function listSubscriptions(status?: SubscriptionStatus) {
  const rows = await prisma.subscription.findMany({
    where: status ? { status } : undefined,
    include: {
      client: { select: { id: true, displayName: true, clientNumber: true, type: true } },
      service: { select: { id: true, name: true } },
      _count: { select: DRAFT_COUNTS },
    },
    orderBy: { createdAt: "desc" },
  });
  const now = new Date();
  const pending = await pendingFirstInvoiceIds(rows, now);
  return rows.map(({ _count, ...r }) => ({
    ...r,
    firstInvoicePending: pending.has(r.id),
    /** « Programmer la fin » : date de fin si elle était programmée maintenant (affichée avant confirmation). */
    scheduledEndAt: r.status === SubscriptionStatus.ENDED ? null : scheduledEndOf(r, now, r.client.type).toISOString(),
    /** Créé à la main, jamais facturé, sans Stripe : supprimable et montant modifiable directement. */
    draftLike: isDraftLike({ ...r, _count }),
  }));
}

/**
 * Correction directe du montant par l'admin : seulement un contrat « brouillon ». Sinon l'avenant (accord du client),
 * dont l'acceptation applique le nouveau montant par updateSubscription, sans passer par ce contrôle.
 */
export async function assertAmountCorrectable(id: string, amountCents: number) {
  const current = await prisma.subscription.findUnique({ where: { id }, select: { amountCents: true } });
  if (!current || current.amountCents === amountCents) return;
  await assertDraftLike(
    id,
    "Le montant de ce contrat ne se change plus directement : il a été facturé, vient d'un devis ou est prélevé par Stripe. Passez par « Réviser (avenant) ».",
  );
}

/** Supprime un contrat créé par erreur ; tout autre contrat se clôture (historique et factures intacts). */
export async function deleteSubscription(id: string) {
  await assertDraftLike(
    id,
    "Ce contrat ne se supprime pas : il a été facturé, vient d'un devis ou est prélevé par Stripe. Clôturez-le.",
  );
  await prisma.subscription.delete({ where: { id } });
}

export async function getSubscription(id: string) {
  return prisma.subscription.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, displayName: true, clientNumber: true } },
      service: { select: { id: true, name: true } },
      invoices: {
        select: { id: true, number: true, issueDate: true, totalCents: true, status: true },
        orderBy: { issueDate: "desc" },
        take: 12,
      },
    },
  });
}

export async function updateSubscription(
  id: string,
  patch: Partial<
    Pick<CreateSubscriptionInput, "label" | "amountCents" | "billingDay" | "endDate" | "billingInterval" | "firstInvoiceAt">
  >,
  db: Db = prisma,
) {
  if (patch.billingDay !== undefined) validateBillingDay(patch.billingDay);
  if (patch.amountCents !== undefined) validateAmount(patch.amountCents);

  const current = await db.subscription.findUnique({ where: { id } });
  if (!current) throw new SubscriptionError("Abonnement introuvable");
  if (current.status === SubscriptionStatus.ENDED) {
    throw new SubscriptionError("Un abonnement clôturé n'est plus modifiable");
  }
  // Changement de périodicité : il prend effet à la prochaine échéance (nextInvoiceAt
  // inchangé). Un prélèvement Stripe suit son propre prix : on ne le change pas d'ici.
  const intervalChanges =
    patch.billingInterval !== undefined &&
    normalizeInterval(patch.billingInterval) !== normalizeInterval(current.billingInterval);
  if (intervalChanges && current.stripeSubscriptionId) {
    throw new SubscriptionError(
      "Prélèvement Stripe actif : changez la périodicité dans Stripe, puis l'abonnement se mettra à jour.",
    );
  }

  // Nouveau jour de facturation : même mois que l'échéance prévue (une 1re échéance différée reste
  // différée), au plus tôt aujourd'hui.
  let nextInvoiceAt: Date | undefined;
  if (patch.billingDay !== undefined && patch.billingDay !== current.billingDay) {
    const planned = current.nextInvoiceAt;
    const sameMonth = new Date(planned.getFullYear(), planned.getMonth(), patch.billingDay, 0, 0, 0, 0);
    nextInvoiceAt = sameMonth < startOfDay(new Date()) ? computeNextInvoiceAt(patch.billingDay, new Date()) : sameMonth;
  }
  // Date de la 1re facture : modifiable tant que l'abonnement n'a rien facturé ni de prélèvement Stripe relié.
  if (patch.firstInvoiceAt) {
    const invoiced = current.lastInvoiceId !== null || (await db.invoice.count({ where: { subscriptionId: id } })) > 0;
    if (invoiced || current.stripeSubscriptionId) {
      throw new SubscriptionError("La date de 1re facture ne se change plus : l'abonnement a déjà été facturé ou prélevé.");
    }
    nextInvoiceAt = validateFirstInvoiceAt(patch.firstInvoiceAt, current.startDate);
  }

  return db.subscription.update({
    where: { id },
    data: {
      label: patch.label,
      amountCents: patch.amountCents,
      billingDay: patch.billingDay,
      billingInterval: intervalChanges ? normalizeInterval(patch.billingInterval) : undefined,
      endDate: patch.endDate,
      nextInvoiceAt,
    },
    include: { client: true, service: true },
  });
}

/** Abonnement prélevé par Stripe : l'action est faite d'abord dans Stripe ; en cas d'échec, rien ne change. */
async function findForStatusChange(id: string) {
  const sub = await prisma.subscription.findUnique({ where: { id } });
  if (!sub) throw new SubscriptionError("Abonnement introuvable");
  return sub;
}

export async function pauseSubscription(id: string) {
  const sub = await findForStatusChange(id);
  if (sub.status !== SubscriptionStatus.ACTIVE) {
    throw new SubscriptionError("Seul un abonnement actif peut être suspendu");
  }
  if (sub.stripeSubscriptionId) await applyStripeSubscriptionAction(sub.stripeSubscriptionId, "pause", sub.stripeLivemode);
  return prisma.subscription.update({
    where: { id },
    data: { status: SubscriptionStatus.PAUSED },
  });
}

export async function resumeSubscription(id: string, now: Date = new Date()) {
  const sub = await prisma.subscription.findUnique({ where: { id } });
  if (!sub) throw new SubscriptionError("Abonnement introuvable");
  if (sub.status !== SubscriptionStatus.PAUSED) {
    throw new SubscriptionError("Seul un abonnement en pause peut être repris");
  }
  if (sub.stripeSubscriptionId) await applyStripeSubscriptionAction(sub.stripeSubscriptionId, "resume", sub.stripeLivemode);
  // L'échéance prévue est gardée ; si elle est passée pendant la suspension, elle va à la
  // prochaine date de facturation (aujourd'hui compris), sans facturer la période suspendue.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nextInvoiceAt =
    sub.nextInvoiceAt >= today ? sub.nextInvoiceAt : computeNextInvoiceAt(sub.billingDay, today);
  return prisma.subscription.update({
    where: { id },
    data: { status: SubscriptionStatus.ACTIVE, nextInvoiceAt },
  });
}

export async function endSubscription(id: string, endDate?: Date) {
  const sub = await findForStatusChange(id);
  if (sub.status === SubscriptionStatus.ENDED) {
    throw new SubscriptionError("Cet abonnement est déjà clôturé");
  }
  if (sub.stripeSubscriptionId) await applyStripeSubscriptionAction(sub.stripeSubscriptionId, "cancel", sub.stripeLivemode);
  const ended = await prisma.subscription.update({
    where: { id },
    data: {
      status: SubscriptionStatus.ENDED,
      endDate: endDate ?? new Date(),
    },
  });
  await rejectObsoleteReviewEmails(id, SUBSCRIPTION_NOTICE_KINDS, "Abonnement clôturé : avis sans objet.");
  return ended;
}

/** Fin de la période de facturation en cours : la prochaine échéance, avancée d'une période tant qu'elle est passée. */
export function currentPeriodEndOf(sub: { nextInvoiceAt: Date; billingInterval: string | null }, now = new Date()): Date {
  const months = periodMonths(sub.billingInterval);
  // Depuis l'échéance prévue, par multiples de la période (pas en chaîne : le jour 29 à 31 glissait au 28).
  let k = 0;
  while (commitmentEndOf(sub.nextInvoiceAt, months * k).getTime() <= now.getTime()) k += 1;
  return k === 0 ? new Date(sub.nextInvoiceAt) : commitmentEndOf(sub.nextInvoiceAt, months * k);
}

/** Date d'effet d'une fin programmée aujourd'hui (« Programmer la fin ») : fin du terme résiliable, sinon de la période. */
export function scheduledEndOf(
  sub: { nextInvoiceAt: Date; billingInterval: string | null; commitmentEndsAt: Date | null; renewalReminderSentFor?: Date | null; renewalReminderSentAt?: Date | null },
  now = new Date(),
  clientType?: string | null,
): Date {
  // L215-1 : non-professionnel sans information de reconduction faite à temps, fin de la période déjà payée.
  return sub.commitmentEndsAt ? cancellableTermOf(sub.commitmentEndsAt, now, renewalNoticeOf(sub, clientType)).termEndsAt : currentPeriodEndOf(sub, now);
}

/**
 * « Programmer la fin » (non-reconduction) : l'abonnement reste actif jusqu'au dernier instant de son terme, sans frais
 * ni échéance ensuite. Abonnement engagé : fin de l'engagement ou de l'année reconduite, préavis d'un mois compris
 * (comme une demande du client) ; sans engagement : fin de la période en cours. Sous Stripe : cancel_at à cette date.
 */
export async function scheduleSubscriptionEnd(id: string, now = new Date()) {
  const sub = await findForStatusChange(id);
  if (sub.status === SubscriptionStatus.ENDED) throw new SubscriptionError("Cet abonnement est déjà clôturé");
  const client = await prisma.client.findUnique({ where: { id: sub.clientId }, select: { type: true } });
  const termEndsAt = scheduledEndOf(sub, now, client?.type);
  const endDate = new Date(termEndsAt.getTime() - 1);
  if (sub.endDate && sub.endDate <= endDate) throw new SubscriptionError("Une fin plus proche est déjà programmée");
  // Sous Stripe : la fin réellement posée (calée sur la fin de période Stripe) fait foi pour l'ERP aussi.
  const stripeEnd = sub.stripeSubscriptionId ? await applyStripeSubscriptionAction(sub.stripeSubscriptionId, "cancelAt", sub.stripeLivemode, termEndsAt) : undefined;
  const scheduled = await prisma.subscription.update({
    where: { id },
    data: stripeEnd ? { endDate: new Date(stripeEnd.getTime() - 1), stripeCancelAt: stripeEnd } : { endDate, ...(sub.stripeSubscriptionId ? { stripeCancelAt: termEndsAt } : {}) },
  });
  // Plus de reconduction : l'information de reconduction et le rappel de fin de période n'ont plus d'objet.
  await rejectObsoleteReviewEmails(id, ["subscription_renewal", "subscription_term_end", "subscription_term_end_buyout"], "Fin programmée : avis de reconduction sans objet.");
  return scheduled;
}

/**
 * « Annuler la fin programmée » (erreur de clic, client qui reste) : l'abonnement reprend sa reconduction ; sous Stripe,
 * cancel_at est retiré d'abord (si Stripe échoue, rien ne change). Refusé après un rachat signé : la fin en découle.
 */
export async function cancelScheduledEnd(id: string) {
  const sub = await findForStatusChange(id);
  if (sub.status === SubscriptionStatus.ENDED) throw new SubscriptionError("Cet abonnement est déjà clôturé");
  if (!sub.endDate) throw new SubscriptionError("Aucune fin n'est programmée");
  const boughtOut = await prisma.invoice.count({
    where: { buysOutSubscriptionId: id, documentType: InvoiceDocumentType.QUOTE, quoteStatus: QuoteStatus.ACCEPTED },
  });
  if (boughtOut) throw new SubscriptionError("Rachat signé : la fin de l'abonnement en découle et ne s'annule pas ici.");
  if (sub.stripeSubscriptionId) await applyStripeSubscriptionAction(sub.stripeSubscriptionId, "keepRenewing", sub.stripeLivemode);
  return prisma.subscription.update({ where: { id }, data: { endDate: null, ...(sub.stripeSubscriptionId ? { stripeCancelAt: null } : {}) } });
}

/** Worker : tout abonnement dont la fin programmée est passée (rachat, non-reconduction, date de fin) est clôturé. */
export async function closeEndedSubscriptions(now = new Date()): Promise<number> {
  const closed = await prisma.subscription.updateMany({
    where: { status: { not: SubscriptionStatus.ENDED }, endDate: { lt: now } },
    // Lien court du portail Stripe retiré avec l'abonnement : un ancien e-mail ne mène plus nulle part.
    data: { status: SubscriptionStatus.ENDED, publicToken: null },
  });
  return closed.count;
}

/** Factures dues d'un abonnement pour son échéance courante. @returns true si une facture a été émise. */
/** Cycle déjà réservé par un passage simultané : rien à émettre. */
class CycleAlreadyClaimedError extends Error {}

/** Nombre de jours civils de `from` à `to` (minuit à minuit, heure de Paris), changement d'heure compris. */
function calendarDaysBetween(from: Date, to: Date): number {
  return Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / 86_400_000);
}

/** Début de la période facturée inscrit sur une ligne d'échéance (« … : période du 01/06/2026 au … »), sinon null. */
function billedPeriodStartOf(description: string | undefined): Date | null {
  const m = description?.match(/période du (\d{2})\/(\d{2})\/(\d{4})/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

async function invoiceSubscriptionCycle(sub: Prisma.SubscriptionGetPayload<{ include: { client: true; service: true } }>, now: Date = new Date()): Promise<boolean> {
  const periodStart = sub.nextInvoiceAt;
  // Échéance en retard (worker arrêté, rattrapage) : facture datée du jour de son émission, jamais dans le passé, pour
  // une numérotation chronologique ; la période facturée figure sur la ligne (décision du 27/10/2026).
  const today = startOfDay(now);
  const issueDate = periodStart < today ? today : periodStart;
  const interval = normalizeInterval(sub.billingInterval);
  const followingInvoiceAt = nextPeriodDate(periodStart, periodMonths(sub.billingInterval), anchorDayOf(sub));
  if (sub.endDate && sub.endDate < periodStart) return false;
  // Période qui dépasse la fin du contrat : dernière facture au prorata des jours jusqu'à la date de fin incluse
  // (décision d'Alexandre du 27/10/2026).
  const periodDays = calendarDaysBetween(periodStart, followingInvoiceAt);
  const lastDay = sub.endDate && sub.endDate < addDays(followingInvoiceAt, -1) ? startOfDay(sub.endDate) : addDays(followingInvoiceAt, -1);
  const billedDays = calendarDaysBetween(periodStart, lastDay) + 1;
  const prorated = billedDays < periodDays;
  const prorate = (cents: number) => (prorated ? Math.round((cents * billedDays) / periodDays) : cents);
  // Annuel et trimestriel, échéance en retard ou au prorata : la période couverte figure sur la ligne ; mensuel à
  // l'heure : le libellé seul.
  const dated = interval !== "MONTH" || issueDate.getTime() !== periodStart.getTime() || prorated;

  // Idempotence : une facture existe déjà pour ce cycle ? Toute facture non annulée datée dans ce cycle compte (une
  // facture Stripe ou manuelle n'est pas forcément datée du jour exact de l'échéance), sauf la facture en retard d'un
  // cycle précédent, datée du jour de son émission : sa ligne porte une période antérieure à ce cycle.
  const candidates = await prisma.invoice.findMany({
    where: {
      subscriptionId: sub.id,
      status: { not: InvoiceStatus.CANCELLED },
      issueDate: {
        gte: startOfDay(periodStart),
        lt: followingInvoiceAt,
      },
    },
    select: { id: true, lines: { select: { description: true }, orderBy: { position: "asc" }, take: 1 } },
  });
  const existing = candidates.find((inv) => {
    const billed = billedPeriodStartOf(inv.lines[0]?.description);
    return !billed || billed >= startOfDay(periodStart);
  });
  if (existing) {
    // Cycle déjà facturé : on avance juste nextInvoiceAt pour ne pas boucler.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { nextInvoiceAt: followingInvoiceAt },
    });
    return false;
  }

  // Création, émission et avance de l'échéance dans une seule transaction :
  // une facture émise dont nextInvoiceAt n'aurait pas avancé serait rejouée
  // au cycle suivant, et un brouillon sans numéro resterait orphelin.
  const settings = await getCompanySettings();
  // Remise du devis signé (R1) : sur les discountPeriods premières échéances facturées, puis tarif plein.
  const discountIndex = sub.discountPeriods && sub.discountPeriodsBilled < sub.discountPeriods ? sub.discountPeriodsBilled + 1 : 0;
  const amountCents = prorate(sub.amountCents);
  const discountCents = discountIndex ? prorate(discountCentsPerPeriod(sub.discountKind, sub.discountValue, sub.amountCents)) : 0;
  const discountLabel =
    sub.discountKind === "PERCENT" && sub.discountValue
      ? `Remise de ${String(sub.discountValue / 100).replace(".", ",")} % (échéance ${discountIndex} sur ${sub.discountPeriods})`
      : `Remise (échéance ${discountIndex} sur ${sub.discountPeriods})`;
  let issued;
  try {
  issued = await prisma.$transaction(async (tx) => {
    // Réservation du cycle, première écriture : l'échéance n'avance que si elle vaut encore celle lue. Un passage
    // simultané (worker et « Générer maintenant ») la trouve déjà avancée et annule tout, numéro compris (audit du
    // 27/10/2026 : trois passages parallèles émettaient trois factures pour le même cycle).
    const claimed = await tx.subscription.updateMany({ where: { id: sub.id, nextInvoiceAt: periodStart }, data: { nextInvoiceAt: followingInvoiceAt } });
    if (claimed.count !== 1) throw new CycleAlreadyClaimedError();
    const invoice = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: sub.clientId,
        subscriptionId: sub.id,
        paymentTerms:
          interval === "YEAR"
            ? "Échéance annuelle : paiement à réception"
            : interval === "QUARTER"
              ? "Échéance trimestrielle : paiement à réception"
              : "Prélèvement mensuel : paiement à réception",
        subtotalCents: amountCents - discountCents,
        totalCents: amountCents - discountCents,
        lines: {
          create: [
            {
              position: 1,
              description: dated
                ? `${sub.label} : période du ${fmtDay(periodStart)} au ${fmtDay(lastDay)}${prorated ? ` (prorata : ${billedDays} jours sur ${periodDays})` : ""}`
                : sub.label,
              quantity: 1,
              unitPriceCents: amountCents,
              lineTotalCents: amountCents,
            },
            ...(discountCents
              ? [{ position: 2, description: discountLabel, quantity: 1, unitPriceCents: -discountCents, lineTotalCents: -discountCents }]
              : []),
          ],
        },
      },
    });

    const emitted = await issueInvoiceWithin(tx, invoice.id, issueDate, issueDate, settings);

    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        lastInvoiceId: emitted.id,
        ...(discountCents ? { discountPeriodsBilled: discountIndex } : {}),
      },
    });

    return emitted;
  });
  } catch (e) {
    if (e instanceof CycleAlreadyClaimedError) return false;
    throw e;
  }

  // Hors transaction : un envoi d'email raté ne doit pas défaire la facture.
  await archiveIssuedDocument(issued.id);
  await sendDocumentPdf(issued.id, { review: { family: "subscription_invoice", origin: "WORKER" } });

  return true;
}

/**
 * Émet tout de suite la 1re facture d'un abonnement dû (devis d'abonnement seul signé, sans Stripe).
 * Même chemin que le cron : idempotent sur le cycle, puis l'échéance avance d'une période.
 */
export async function invoiceSubscriptionNow(subscriptionId: string, now: Date = new Date()): Promise<boolean> {
  const sub = await prisma.subscription.findFirst({
    where: {
      id: subscriptionId,
      status: SubscriptionStatus.ACTIVE,
      collectionMethod: { not: SubscriptionCollectionMethod.STRIPE },
      nextInvoiceAt: { lte: now },
    },
    include: { client: true, service: true },
  });
  return sub ? invoiceSubscriptionCycle(sub, now) : false;
}

/**
 * Génère et émet les factures dues pour tous les abonnements ACTIVE dont
 * nextInvoiceAt <= now. Idempotent : saute si une facture existe déjà pour
 * (subscriptionId, nextInvoiceAt).
 * @returns nombre de factures émises.
 */
export async function generateDueSubscriptionInvoices(now: Date = new Date()): Promise<number> {
  const due = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      // Stripe Billing émet les factures via webhook (invoice.finalized).
      collectionMethod: { not: SubscriptionCollectionMethod.STRIPE },
      nextInvoiceAt: { lte: now },
      // Ne pas facturer au-delà de la date de fin éventuelle
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    include: { client: true, service: true },
  });

  let generated = 0;
  // Un abonnement en erreur (client incomplet, numérotation) ne bloque pas les autres ; il est repris au passage suivant.
  for (const sub of due) {
    try {
      if (await invoiceSubscriptionCycle(sub, now)) generated += 1;
    } catch (err) {
      console.error(`[subscriptions] facture de l'abonnement ${sub.id} non émise`, err);
    }
  }

  return generated;
}

export type MrrSnapshot = {
  mrrCents: number;
  arrCents: number;
  activeCount: number;
  /** Abonnements actifs dont la 1re facture est à venir (ex. une année offerte) : hors MRR et ARR. */
  upcomingCount: number;
  upcomingMrrCents: number;
  bySubscription: Array<{
    id: string;
    label: string;
    amountCents: number;
    billingInterval: BillingInterval;
    /** Équivalent mensuel (montant annuel / 12) */
    monthlyCents: number;
    clientDisplayName: string;
    nextInvoiceAt: Date;
    upcoming: boolean;
  }>;
};

export async function computeMrrCents(now: Date = new Date()): Promise<MrrSnapshot> {
  const active = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    include: {
      client: { select: { displayName: true } },
    },
    orderBy: { nextInvoiceAt: "asc" },
  });

  const pending = await pendingFirstInvoiceIds(active, now);
  const bySubscription = active.map((sub) => ({
    id: sub.id,
    label: sub.label,
    amountCents: sub.amountCents,
    billingInterval: normalizeInterval(sub.billingInterval),
    monthlyCents: monthlyEquivalentCents(sub.amountCents, sub.billingInterval),
    clientDisplayName: sub.client.displayName,
    nextInvoiceAt: sub.nextInvoiceAt,
    upcoming: pending.has(sub.id),
  }));
  const counted = bySubscription.filter((s) => !s.upcoming);
  const upcoming = bySubscription.filter((s) => s.upcoming);
  const mrrCents = counted.reduce((s, sub) => s + sub.monthlyCents, 0);
  // ARR : montants réellement facturés sur 12 mois (sans l'arrondi du /12 des annuels).
  const arrCents = counted.reduce((s, sub) => s + sub.amountCents * (12 / periodMonths(sub.billingInterval)), 0);
  return {
    mrrCents,
    arrCents,
    activeCount: active.length,
    upcomingCount: upcoming.length,
    upcomingMrrCents: upcoming.reduce((s, sub) => s + sub.monthlyCents, 0),
    bySubscription,
  };
}

export type RevisionResult = {
  quoteId: string;
  quoteNumber: string | null;
  emailed: boolean;
};

/**
 * Révision légale d'un abonnement : crée un devis d'avenant au nouveau montant,
 * l'émet (numéro D-YYYY-NNNN) et envoie le PDF au client. L'abonnement n'est
 * mis à jour qu'à l'acceptation du devis (conversion en facture), ce qui
 * émet alors la facture correspondante.
 * Un changement de périodicité (mensuel ou annuel) passe aussi par ce devis :
 * il s'applique à la prochaine échéance, une fois le devis accepté.
 */
export async function createSubscriptionRevision(opts: {
  subscriptionId: string;
  amountCents: number;
  label?: string;
  billingDay?: number;
  billingInterval?: BillingInterval;
}): Promise<RevisionResult> {
  validateAmount(opts.amountCents);
  if (opts.billingDay !== undefined) validateBillingDay(opts.billingDay);

  const sub = await prisma.subscription.findUnique({
    where: { id: opts.subscriptionId },
    include: { client: true, service: true },
  });
  if (!sub) throw new SubscriptionError("Abonnement introuvable");
  if (sub.status !== SubscriptionStatus.ACTIVE) {
    throw new SubscriptionError("Seul un abonnement actif peut être révisé");
  }

  const label = opts.label?.trim() || sub.label;
  const billingDay = opts.billingDay ?? sub.billingDay;
  const billingInterval = normalizeInterval(opts.billingInterval ?? sub.billingInterval);
  if (billingInterval !== normalizeInterval(sub.billingInterval) && sub.stripeSubscriptionId) {
    throw new SubscriptionError(
      "Prélèvement Stripe actif : changez la périodicité dans Stripe, puis l'abonnement se mettra à jour.",
    );
  }
  const amountCents = opts.amountCents;

  // Création du devis d'avenant (brouillon) avec une ligne abonnement.
  const draft = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      quoteStatus: QuoteStatus.DRAFT,
      clientId: sub.clientId,
      paymentTerms: "Devis valable 30 jours",
      subtotalCents: amountCents,
      totalCents: amountCents,
      lines: {
        create: {
          position: 1,
          description: label,
          quantity: 1,
          unitPriceCents: amountCents,
          lineTotalCents: amountCents,
          isSubscription: true,
          billingDay,
          billingInterval,
          serviceId: sub.serviceId,
          // Acceptation : met à jour cet abonnement-ci (un client peut en avoir plusieurs).
          revisesSubscriptionId: sub.id,
        },
      },
    },
    include: { lines: true },
  });

  // Émission : alloue le numéro légal, fige le snapshot, passe en SENT.
  const issued = await issueQuote(draft.id);

  // Envoi du PDF au client.
  const mail = await sendDocumentPdf(issued.id, { send: true, review: { family: "document", origin: "ADMIN_ACTION" } });

  return {
    quoteId: issued.id,
    quoteNumber: issued.number,
    emailed: mail.sent,
  };
}
