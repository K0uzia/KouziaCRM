import { InvoiceDocumentType } from "@prisma/client";
import { decryptOptional } from "@/lib/crypto";
import { isSmtpConfigured, sendEmail } from "@/lib/email/smtp";
import {
  brandFromSettings,
  buildEmailContent,
  type EmailTemplateKind,
} from "@/lib/email/templates";
import { listPendingReminders, markReminderSent } from "@/lib/reminders";

type PendingInvoice = Awaited<ReturnType<typeof listPendingReminders>>[number];

function reminderKind(invoice: PendingInvoice): EmailTemplateKind {
  const count = invoice.reminderCount ?? 0;
  if (count >= 2) return "reminder_formal";
  if (count >= 1) return "reminder_firm";
  return "reminder_soft";
}

/** Envoie automatiquement les relances dues via SMTP (si configuré). */
export async function sendDueReminders(now: Date = new Date()): Promise<number> {
  if (!isSmtpConfigured()) return 0;

  const pending = await listPendingReminders(now);
  const brand = await brandFromSettings();
  let sent = 0;

  for (const invoice of pending) {
    const to = decryptOptional(invoice.client.emailEncrypted);
    if (!to) continue;

    try {
      const isQuote = invoice.documentType === InvoiceDocumentType.QUOTE;
      const built = buildEmailContent({
        kind: reminderKind(invoice),
        clientName: invoice.client.displayName,
        clientFirstName: invoice.client.displayName.split(/\s+/)[0],
        docNumber: invoice.number,
        docLabel: isQuote ? "devis" : "facture",
        brand,
      });
      await sendEmail({
        to,
        subject: built.subject,
        text: built.text,
        html: built.html,
      });
      await markReminderSent(invoice.id, now);
      sent += 1;
    } catch (err) {
      console.error(`[reminders] envoi échoué pour ${invoice.id}`, err);
    }
  }

  return sent;
}
