import {
  InvoiceDocumentType,
  InvoiceStatus,
  QuoteStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/** Devis SENT dont validUntil est dépassé -> EXPIRED */
export async function expireQuotes(now = new Date()): Promise<number> {
  const result = await prisma.invoice.updateMany({
    where: {
      documentType: InvoiceDocumentType.QUOTE,
      quoteStatus: QuoteStatus.SENT,
      validUntil: { lt: now },
    },
    data: {
      quoteStatus: QuoteStatus.EXPIRED,
      status: InvoiceStatus.CANCELLED,
    },
  });
  return result.count;
}

/**
 * Calcule nextReminderAt pour devis SENT et factures ISSUED non soldées.
 * Ne touche pas les documents déjà planifiés dans le futur.
 */
export async function scheduleReminders(now = new Date()): Promise<number> {
  const settings = await getCompanySettings();
  let updated = 0;

  const quotes = await prisma.invoice.findMany({
    where: {
      documentType: InvoiceDocumentType.QUOTE,
      quoteStatus: QuoteStatus.SENT,
      OR: [{ nextReminderAt: null }, { nextReminderAt: { lte: now } }],
    },
  });

  for (const q of quotes) {
    const base = q.lastReminderAt ?? q.issuedAt ?? q.issueDate ?? q.createdAt;
    const next = addDays(base, settings.reminderQuoteDays);
    if (!q.nextReminderAt || q.nextReminderAt <= now) {
      await prisma.invoice.update({
        where: { id: q.id },
        data: { nextReminderAt: next > now ? next : now },
      });
      updated += 1;
    }
  }

  const invoices = await prisma.invoice.findMany({
    where: {
      documentType: InvoiceDocumentType.INVOICE,
      status: InvoiceStatus.ISSUED,
      OR: [{ nextReminderAt: null }, { nextReminderAt: { lte: now } }],
    },
    include: { payments: true },
  });

  for (const inv of invoices) {
    const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
    if (paid >= inv.totalCents) continue;
    const base =
      inv.lastReminderAt ?? inv.dueDate ?? inv.issuedAt ?? inv.issueDate ?? inv.createdAt;
    const next = addDays(base, settings.reminderInvoiceDays);
    if (!inv.nextReminderAt || inv.nextReminderAt <= now) {
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { nextReminderAt: next > now ? next : now },
      });
      updated += 1;
    }
  }

  return updated;
}

/** Remet à zéro les compteurs de relance si un email inbound mentionne le numéro */
export async function resetRemindersForMatchedDocuments(
  subject: string,
  bodyText: string | null,
): Promise<number> {
  const haystack = `${subject}\n${bodyText ?? ""}`;
  const numbers = haystack.match(/\b(?:D-)?\d{4}-\d{3,}\b/gi) ?? [];
  if (numbers.length === 0) return 0;

  let n = 0;
  for (const raw of numbers) {
    const number = raw.toUpperCase();
    const updated = await prisma.invoice.updateMany({
      where: { number },
      data: {
        reminderCount: 0,
        lastReminderAt: null,
        nextReminderAt: null,
      },
    });
    n += updated.count;
  }
  return n;
}

export async function listPendingReminders(now = new Date()) {
  return prisma.invoice.findMany({
    where: {
      nextReminderAt: { lte: now },
      OR: [
        {
          documentType: InvoiceDocumentType.QUOTE,
          quoteStatus: QuoteStatus.SENT,
        },
        {
          documentType: InvoiceDocumentType.INVOICE,
          status: InvoiceStatus.ISSUED,
        },
      ],
    },
    include: {
      client: {
        select: {
          id: true,
          displayName: true,
          clientNumber: true,
          emailEncrypted: true,
        },
      },
    },
    orderBy: { nextReminderAt: "asc" },
    take: 50,
  });
}

export async function markReminderSent(invoiceId: string, now = new Date()) {
  const settings = await getCompanySettings();
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const days =
    inv.documentType === InvoiceDocumentType.QUOTE
      ? settings.reminderQuoteDays
      : settings.reminderInvoiceDays;
  return prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      lastReminderAt: now,
      reminderCount: { increment: 1 },
      nextReminderAt: addDays(now, days),
    },
  });
}
