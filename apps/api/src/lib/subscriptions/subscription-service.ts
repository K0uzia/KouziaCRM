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

/** Périodicité d'un abonnement ; null en base vaut MONTH. */
export type BillingInterval = "MONTH" | "YEAR";

export function normalizeInterval(value: string | null | undefined): BillingInterval {
  return value === "YEAR" ? "YEAR" : "MONTH";
}

/** Nombre de mois couverts par une échéance. */
export function periodMonths(interval: string | null | undefined): number {
  return normalizeInterval(interval) === "YEAR" ? 12 : 1;
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
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
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

  // Un seul abonnement actif par client : on bloque la création doublon.
  const existingActive = await db.subscription.findFirst({
    where: { clientId: data.clientId, status: SubscriptionStatus.ACTIVE },
    select: { id: true, label: true },
  });
  if (existingActive) {
    throw new SubscriptionError(
      "Ce client a déjà un abonnement actif. Modifiez-le ou clôturez-le d'abord.",
    );
  }

  const startDate = data.startDate ?? new Date();
  const billingInterval = normalizeInterval(data.billingInterval);
  let nextInvoiceAt = computeNextInvoiceAt(data.billingDay, startDate);
  if (data.firstPeriodNow) {
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
      status: SubscriptionStatus.ACTIVE,
      nextInvoiceAt,
      ...(data.collectionMethod ? { collectionMethod: data.collectionMethod } : {}),
    },
    include: { client: true, service: true },
  });
}

export async function listSubscriptions(status?: SubscriptionStatus) {
  return prisma.subscription.findMany({
    where: status ? { status } : undefined,
    include: {
      client: { select: { id: true, displayName: true, clientNumber: true } },
      service: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
  });
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
    Pick<CreateSubscriptionInput, "label" | "amountCents" | "billingDay" | "endDate" | "billingInterval">
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

  // Si billingDay change et qu'aucune facture n'a encore été émise pour le cycle courant,
  // on recalcul nextInvoiceAt.
  let nextInvoiceAt: Date | undefined;
  if (patch.billingDay !== undefined && patch.billingDay !== current.billingDay) {
    nextInvoiceAt = computeNextInvoiceAt(patch.billingDay, new Date());
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
  return prisma.subscription.update({
    where: { id },
    data: {
      status: SubscriptionStatus.ENDED,
      endDate: endDate ?? new Date(),
    },
  });
}

/** Factures dues d'un abonnement pour son échéance courante. @returns true si une facture a été émise. */
async function invoiceSubscriptionCycle(sub: Prisma.SubscriptionGetPayload<{ include: { client: true; service: true } }>): Promise<boolean> {
  const issueDate = sub.nextInvoiceAt;
  const yearly = normalizeInterval(sub.billingInterval) === "YEAR";
  const followingInvoiceAt = addMonths(issueDate, periodMonths(sub.billingInterval));

  // Idempotence : une facture existe déjà pour ce cycle ?
  // Toute facture non annulée datée dans ce cycle compte (une facture Stripe ou manuelle
  // n'est pas forcément datée du jour exact de l'échéance).
  const existing = await prisma.invoice.findFirst({
    where: {
      subscriptionId: sub.id,
      status: { not: InvoiceStatus.CANCELLED },
      issueDate: {
        gte: new Date(issueDate.getFullYear(), issueDate.getMonth(), issueDate.getDate(), 0, 0, 0, 0),
        lt: followingInvoiceAt,
      },
    },
    select: { id: true },
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
  const issued = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: sub.clientId,
        subscriptionId: sub.id,
        paymentTerms: yearly
          ? "Échéance annuelle : paiement à réception"
          : "Prélèvement mensuel : paiement à réception",
        subtotalCents: sub.amountCents,
        totalCents: sub.amountCents,
        lines: {
          create: {
            position: 1,
            description: yearly ? `${sub.label} : période du ${fmtDay(issueDate)} au ${fmtDay(addDays(followingInvoiceAt, -1))}` : sub.label,
            quantity: 1,
            unitPriceCents: sub.amountCents,
            lineTotalCents: sub.amountCents,
          },
        },
      },
    });

    const emitted = await issueInvoiceWithin(tx, invoice.id, issueDate, issueDate, settings);

    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        lastInvoiceId: emitted.id,
        nextInvoiceAt: followingInvoiceAt,
      },
    });

    return emitted;
  });

  // Hors transaction : un envoi d'email raté ne doit pas défaire la facture.
  await archiveIssuedDocument(issued.id);
  await sendDocumentPdf(issued.id);

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
  return sub ? invoiceSubscriptionCycle(sub) : false;
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
  for (const sub of due) {
    if (await invoiceSubscriptionCycle(sub)) generated += 1;
  }

  return generated;
}

export type MrrSnapshot = {
  mrrCents: number;
  arrCents: number;
  activeCount: number;
  bySubscription: Array<{
    id: string;
    label: string;
    amountCents: number;
    billingInterval: BillingInterval;
    /** Équivalent mensuel (montant annuel / 12) */
    monthlyCents: number;
    clientDisplayName: string;
    nextInvoiceAt: Date;
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

  const bySubscription = active.map((sub) => ({
    id: sub.id,
    label: sub.label,
    amountCents: sub.amountCents,
    billingInterval: normalizeInterval(sub.billingInterval),
    monthlyCents: monthlyEquivalentCents(sub.amountCents, sub.billingInterval),
    clientDisplayName: sub.client.displayName,
    nextInvoiceAt: sub.nextInvoiceAt,
  }));
  const mrrCents = bySubscription.reduce((s, sub) => s + sub.monthlyCents, 0);
  // ARR : montants réellement facturés sur 12 mois (sans l'arrondi du /12 des annuels).
  const arrCents = bySubscription.reduce((s, sub) => s + sub.amountCents * (12 / periodMonths(sub.billingInterval)), 0);
  return {
    mrrCents,
    arrCents,
    activeCount: active.length,
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
        },
      },
    },
    include: { lines: true },
  });

  // Émission : alloue le numéro légal, fige le snapshot, passe en SENT.
  const issued = await issueQuote(draft.id);

  // Envoi du PDF au client.
  const mail = await sendDocumentPdf(issued.id, { send: true });

  return {
    quoteId: issued.id,
    quoteNumber: issued.number,
    emailed: mail.sent,
  };
}
