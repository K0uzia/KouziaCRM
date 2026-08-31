import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  QuoteStatus,
  SubscriptionStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { issueInvoiceWithin, issueQuote } from "@/lib/invoices/transitions";
import { sendDocumentPdf } from "@/lib/email/send-document-pdf";
import { getCompanySettings } from "@/lib/company";

export type CreateSubscriptionInput = {
  clientId: string;
  serviceId: string;
  label: string;
  amountCents: number;
  billingDay: number;
  startDate: Date;
  endDate?: Date | null;
  /** Si true : 1ʳᵉ échéance déjà facturée (devis) → nextInvoiceAt = mois suivant */
  skipCurrentPeriod?: boolean;
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
  let nextInvoiceAt = computeNextInvoiceAt(data.billingDay, startDate);
  if (data.skipCurrentPeriod) {
    // Mois suivant au billingDay (1ʳᵉ échéance déjà dans le devis/facture)
    nextInvoiceAt = new Date(
      startDate.getFullYear(),
      startDate.getMonth() + 1,
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
      startDate,
      endDate: data.endDate ?? null,
      status: SubscriptionStatus.ACTIVE,
      nextInvoiceAt,
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
  patch: Partial<Pick<CreateSubscriptionInput, "label" | "amountCents" | "billingDay" | "endDate">>,
  db: Db = prisma,
) {
  if (patch.billingDay !== undefined) validateBillingDay(patch.billingDay);
  if (patch.amountCents !== undefined) validateAmount(patch.amountCents);

  const current = await db.subscription.findUnique({ where: { id } });
  if (!current) throw new SubscriptionError("Abonnement introuvable");
  if (current.status === SubscriptionStatus.ENDED) {
    throw new SubscriptionError("Un abonnement clôturé n'est plus modifiable");
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
      endDate: patch.endDate,
      nextInvoiceAt,
    },
    include: { client: true, service: true },
  });
}

export async function pauseSubscription(id: string) {
  return prisma.subscription.update({
    where: { id },
    data: { status: SubscriptionStatus.PAUSED },
  });
}

export async function resumeSubscription(id: string) {
  const sub = await prisma.subscription.findUnique({ where: { id } });
  if (!sub) throw new SubscriptionError("Abonnement introuvable");
  if (sub.status !== SubscriptionStatus.PAUSED) {
    throw new SubscriptionError("Seul un abonnement en pause peut être repris");
  }
  // Repousse la prochaine échéance au prochain billingDay >= now.
  return prisma.subscription.update({
    where: { id },
    data: {
      status: SubscriptionStatus.ACTIVE,
      nextInvoiceAt: computeNextInvoiceAt(sub.billingDay, new Date()),
    },
  });
}

export async function endSubscription(id: string, endDate?: Date) {
  return prisma.subscription.update({
    where: { id },
    data: {
      status: SubscriptionStatus.ENDED,
      endDate: endDate ?? new Date(),
    },
  });
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
      nextInvoiceAt: { lte: now },
      // Ne pas facturer au-delà de la date de fin éventuelle
      OR: [{ endDate: null }, { endDate: { gte: now } }],
    },
    include: { client: true, service: true },
  });

  let generated = 0;
  for (const sub of due) {
    const issueDate = sub.nextInvoiceAt;

    // Idempotence : une facture existe déjà pour ce cycle ?
    const existing = await prisma.invoice.findFirst({
      where: {
        subscriptionId: sub.id,
        issueDate: {
          gte: new Date(issueDate.getFullYear(), issueDate.getMonth(), issueDate.getDate(), 0, 0, 0, 0),
          lte: new Date(issueDate.getFullYear(), issueDate.getMonth(), issueDate.getDate(), 23, 59, 59, 999),
        },
      },
      select: { id: true },
    });
    if (existing) {
      // Cycle déjà facturé : on avance juste nextInvoiceAt pour ne pas boucler.
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { nextInvoiceAt: addMonths(issueDate, 1) },
      });
      continue;
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
          paymentTerms: "Prélèvement mensuel : paiement à réception",
          subtotalCents: sub.amountCents,
          totalCents: sub.amountCents,
          lines: {
            create: {
              position: 1,
              description: sub.label,
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
          nextInvoiceAt: addMonths(issueDate, 1),
        },
      });

      return emitted;
    });

    // Hors transaction : un envoi d'email raté ne doit pas défaire la facture.
    await sendDocumentPdf(issued.id);

    generated += 1;
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

  const mrrCents = active.reduce((s: number, sub: { amountCents: number }) => s + sub.amountCents, 0);
  return {
    mrrCents,
    arrCents: mrrCents * 12,
    activeCount: active.length,
    bySubscription: active.map((sub: {
      id: string;
      label: string;
      amountCents: number;
      nextInvoiceAt: Date;
      client: { displayName: string };
    }) => ({
      id: sub.id,
      label: sub.label,
      amountCents: sub.amountCents,
      clientDisplayName: sub.client.displayName,
      nextInvoiceAt: sub.nextInvoiceAt,
    })),
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
 */
export async function createSubscriptionRevision(opts: {
  subscriptionId: string;
  amountCents: number;
  label?: string;
  billingDay?: number;
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
