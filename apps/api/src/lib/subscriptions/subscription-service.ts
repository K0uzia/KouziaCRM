import { InvoiceDocumentType, InvoiceStatus, InvoiceType, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptOptional } from "@/lib/crypto";
import { issueInvoice } from "@/lib/invoices/transitions";
import { isSmtpConfigured, sendEmail } from "@/lib/email/smtp";
import { renderInvoicePdf, type InvoicePdfData } from "@/lib/pdf/render";
import { getCompanySettings } from "@/lib/company";

export type CreateSubscriptionInput = {
  clientId: string;
  serviceId: string;
  label: string;
  amountCents: number;
  billingDay: number;
  startDate: Date;
  endDate?: Date | null;
};

export class SubscriptionError extends Error {}

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

export async function createSubscription(data: CreateSubscriptionInput) {
  validateBillingDay(data.billingDay);
  validateAmount(data.amountCents);

  const client = await prisma.client.findUnique({ where: { id: data.clientId } });
  if (!client) throw new SubscriptionError("Client introuvable");

  const service = await prisma.service.findUnique({ where: { id: data.serviceId } });
  if (!service) throw new SubscriptionError("Service introuvable");

  const startDate = data.startDate ?? new Date();
  const nextInvoiceAt = computeNextInvoiceAt(data.billingDay, startDate);

  return prisma.subscription.create({
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
) {
  if (patch.billingDay !== undefined) validateBillingDay(patch.billingDay);
  if (patch.amountCents !== undefined) validateAmount(patch.amountCents);

  const current = await prisma.subscription.findUnique({ where: { id } });
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

  return prisma.subscription.update({
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

    // Création de la facture DRAFT avec une ligne.
    const invoice = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: sub.clientId,
        subscriptionId: sub.id,
        paymentTerms: "Prélèvement mensuel — paiement à réception",
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

    // Émission (alloue numéro légal, fige snapshot, passe en ISSUED).
    const issued = await issueInvoice(invoice.id, issueDate, issueDate);

    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        lastInvoiceId: issued.id,
        nextInvoiceAt: addMonths(issueDate, 1),
      },
    });

    // Envoi PDF au client si SMTP configuré et email connu.
    await trySendInvoicePdf(issued.id);

    generated += 1;
  }

  return generated;
}

async function trySendInvoicePdf(invoiceId: string): Promise<void> {
  if (!isSmtpConfigured()) return;
  try {
    const [company, invoice] = await Promise.all([
      getCompanySettings(),
      prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
          client: true,
          lines: { orderBy: { position: "asc" } },
          legalClauses: true,
        },
      }),
    ]);
    if (!invoice) return;
    const email = decryptOptional(invoice.client.emailEncrypted);
    if (!email) return;

    const snapshot = (invoice.clientSnapshot ?? {}) as InvoicePdfData["client"];
    const data: InvoicePdfData = {
      company,
      client: snapshot,
      invoice: {
        number: invoice.number ?? "",
        documentType: invoice.documentType,
        invoiceType: invoice.invoiceType,
        issueDate: invoice.issueDate ?? new Date(),
        dueDate: invoice.dueDate,
        paymentTerms: invoice.paymentTerms,
        notes: invoice.notes,
        subtotalCents: invoice.subtotalCents,
        totalCents: invoice.totalCents,
        creditedInvoiceNumber: null,
        lines: invoice.lines.map((l: { description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }) => ({
          description: l.description,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          lineTotalCents: l.lineTotalCents,
        })),
        legalClauses: invoice.legalClauses.map((c: { title: string; body: string }) => ({ title: c.title, body: c.body })),
      },
    };
    const pdf = await renderInvoicePdf(data);
    await sendEmail({
      to: email,
      subject: `Facture ${invoice.number} — ${company.tradeName ?? company.legalName}`,
      text: `Bonjour,\n\nVeuillez trouver ci-joint votre facture ${invoice.number}.\n\n${company.legalName}`,
      attachments: [
        { filename: `${invoice.number ?? "facture"}.pdf`, content: pdf, contentType: "application/pdf" },
      ],
    });
  } catch (err) {
    console.error(`[subscriptions] envoi PDF échoué pour ${invoiceId}`, err);
  }
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
