import { EmailOutboxStatus, InvoiceDocumentType, LegalClauseKind } from "@prisma/client";
import { decryptOptional } from "@/lib/crypto.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import {
  brandFromSettings,
  buildEmailContent,
  type EmailTemplateKind,
} from "@/lib/email/templates.js";
import { listPendingReminders, markReminderQueued } from "@/lib/reminders.js";
import { clausesForClient, fillClauseVariables, listActiveLegalClauses } from "@/lib/company/legal-clauses.js";
import { getCompanySettings } from "@/lib/company.js";
import { prisma } from "@/lib/prisma.js";
import type { EmailOrigin } from "@/lib/email/review.js";

type PendingInvoice = Awaited<ReturnType<typeof listPendingReminders>>[number];

const REMINDER_KINDS = ["reminder_soft", "reminder_firm", "reminder_formal"];
const OPEN_STATUSES = [EmailOutboxStatus.REVIEW, EmailOutboxStatus.PENDING, EmailOutboxStatus.SENDING];

function reminderKind(invoice: PendingInvoice): EmailTemplateKind {
  // Un devis n'est jamais « impayé » : ni relance de règlement ni mise en demeure avec pénalités (audit du 27/10/2026).
  if (invoice.documentType === InvoiceDocumentType.QUOTE) return "reminder_soft";
  const count = invoice.reminderCount ?? 0;
  if (count >= 2) return "reminder_formal";
  if (count >= 1) return "reminder_firm";
  return "reminder_soft";
}

/** Clause « pénalités de retard » des réglages pour ce type de client, variables remplies ; null sans clause. */
export async function penaltyClauseText(clientType: string | null | undefined): Promise<string | null> {
  const clause = clausesForClient(await listActiveLegalClauses(), clientType).find((c) => c.kind === LegalClauseKind.PENALTY);
  return clause ? fillClauseVariables(clause.body, await getCompanySettings()) : null;
}

/** Enfile les relances dues via EmailOutbox (si SMTP configuré). */
/** origin : WORKER (chaque heure) ou ADMIN_ACTION (« Relancer maintenant » des relances automatiques). */
export async function sendDueReminders(now: Date = new Date(), origin: EmailOrigin = "WORKER"): Promise<number> {
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
    // Une relance déjà ouverte (à valider, en file, en cours d'envoi) : jamais de copie (audit du 27/10/2026 :
    // scheduleReminders replanifiait la relance en attente, d'où une copie de plus à valider chaque heure).
    const open = await prisma.emailOutbox.count({
      where: { documentId: invoice.id, reviewKind: { in: REMINDER_KINDS }, status: { in: OPEN_STATUSES } },
    });
    if (open > 0) continue;

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
        ...(kind === "reminder_formal" ? { penaltyText: await penaltyClauseText(invoice.client.type) } : {}),
      });
      const { awaitingReview } = await mailEnqueue(
        {
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
        },
        { review: { family: kind === "reminder_formal" ? "formal_notice" : "reminder", origin } },
      );
      // En attente de validation : hors sélection (nextReminderAt nul) tant qu'elle n'est ni envoyée ni refusée,
      // sinon le worker en remettrait une copie chaque heure.
      if (awaitingReview) await prisma.invoice.update({ where: { id: invoice.id }, data: { nextReminderAt: null } });
      else await markReminderQueued(invoice.id, now);
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
