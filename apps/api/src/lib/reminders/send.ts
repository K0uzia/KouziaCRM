import { InvoiceDocumentType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptOptional } from "@/lib/crypto";
import { isSmtpConfigured, sendEmail } from "@/lib/email/smtp";
import { listPendingReminders, markReminderSent } from "@/lib/reminders";

type PendingInvoice = Awaited<ReturnType<typeof listPendingReminders>>[number];

function buildReminderMessage(invoice: PendingInvoice): {
  subject: string;
  body: string;
} {
  const label = invoice.documentType === InvoiceDocumentType.QUOTE ? "devis" : "facture";
  const subject = `Relance - ${label} ${invoice.number ?? "brouillon"}`;
  const body = `Bonjour,\n\nSauf erreur de notre part, le ${label} ${invoice.number ?? ""} est en attente de règlement.\n\nCordialement,\nKouzia`;
  return { subject, body };
}

/**
 * Envoie automatiquement les relances dues via SMTP (si configuré).
 * @returns nombre de relances envoyées.
 */
export async function sendDueReminders(now: Date = new Date()): Promise<number> {
  if (!isSmtpConfigured()) return 0;

  const pending = await listPendingReminders(now);
  let sent = 0;

  for (const invoice of pending) {
    const client = await prisma.client.findUnique({
      where: { id: invoice.client.id },
      select: { emailEncrypted: true },
    });
    const email = client ? decryptOptional(client.emailEncrypted) : null;
    if (!email) continue;

    try {
      const { subject, body } = buildReminderMessage(invoice);
      await sendEmail({ to: email, subject, text: body });
      await markReminderSent(invoice.id, now);
      sent += 1;
    } catch (err) {
      console.error(`[reminders] envoi échoué pour ${invoice.id}`, err);
    }
  }

  return sent;
}
