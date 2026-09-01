import { InvoiceDocumentType } from "@prisma/client";
import { decryptOptional } from "@/lib/crypto";
import { isSmtpConfigured } from "@/lib/email/smtp";
import { mailEnqueue } from "@/lib/email/mailer";
import {
  brandFromSettings,
  buildEmailContent,
  type EmailTemplateKind,
} from "@/lib/email/templates";
import { listPendingReminders, markReminderQueued } from "@/lib/reminders";

type PendingInvoice = Awaited<ReturnType<typeof listPendingReminders>>[number];

function reminderKind(invoice: PendingInvoice): EmailTemplateKind {
  const count = invoice.reminderCount ?? 0;
  if (count >= 2) return "reminder_formal";
  if (count >= 1) return "reminder_firm";
  return "reminder_soft";
}

/** Enfile les relances dues via EmailOutbox (si SMTP configuré). */
export async function sendDueReminders(now: Date = new Date()): Promise<number> {
  if (!(await isSmtpConfigured())) {
    console.warn("[reminders] SMTP non configuré, relances ignorées");
    return 0;
  }

  const pending = await listPendingReminders(now);
  if (pending.length === 0) return 0;

  console.log(`[reminders] ${pending.length} relance(s) éligible(s)`);
  const brand = await brandFromSettings();
  let queued = 0;
  let skippedNoEmail = 0;

  for (const invoice of pending) {
    const to = decryptOptional(invoice.client.emailEncrypted);
    if (!to) {
      skippedNoEmail += 1;
      continue;
    }

    try {
      const isQuote = invoice.documentType === InvoiceDocumentType.QUOTE;
      const kind = reminderKind(invoice);
      const built = await buildEmailContent({
        kind,
        clientName: invoice.client.displayName,
        clientFirstName: invoice.client.displayName.split(/\s+/)[0],
        docNumber: invoice.number,
        docLabel: isQuote ? "devis" : "facture",
        brand,
      });
      await mailEnqueue({
        to,
        subject: built.subject,
        text: built.text,
        html: built.html,
        clientId: invoice.clientId,
        documentId: invoice.id,
        documentNumber: invoice.number ?? undefined,
        kind,
        reminderInvoiceId: invoice.id,
        bodyTextForMessage: built.text,
      });
      await markReminderQueued(invoice.id, now);
      queued += 1;
    } catch (err) {
      console.error(`[reminders] enqueue échoué pour ${invoice.id}`, err);
    }
  }

  if (skippedNoEmail > 0) {
    console.warn(`[reminders] ${skippedNoEmail} relance(s) ignorée(s) : client sans email`);
  }
  if (queued > 0) {
    console.log(`[reminders] ${queued} relance(s) enfilée(s)`);
  }

  return queued;
}

export { sendDueDepositReminders } from "@/lib/reminders/deposit-send.js";
