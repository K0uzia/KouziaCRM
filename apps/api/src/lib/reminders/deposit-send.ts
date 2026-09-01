import { InvoiceDocumentType, MilestoneStatus, QuoteStatus } from "@prisma/client";
import { decryptOptional } from "@/lib/crypto";
import { isSmtpConfigured } from "@/lib/email/smtp";
import { mailEnqueue } from "@/lib/email/mailer";
import { brandFromSettings, buildEmailContent } from "@/lib/email/templates";
import { getCompanySettings } from "@/lib/company";
import { prisma } from "@/lib/prisma";

type DepositStage = "minus7" | "minus1" | "plus3" | "plus10";

const STAGE_KIND: Record<DepositStage, string> = {
  minus7: "deposit_reminder_minus7",
  minus1: "deposit_reminder_minus1",
  plus3: "deposit_reminder_plus3",
  plus10: "deposit_reminder_plus10",
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return startOfDay(out);
}

function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

async function alreadySent(milestoneId: string, kind: string, now: Date): Promise<boolean> {
  const start = startOfDay(now);
  const n = await prisma.clientEmailEvent.count({
    where: {
      documentId: milestoneId,
      kind,
      sentAt: { gte: start },
    },
  });
  return n > 0;
}

function stageConfig(
  settings: Awaited<ReturnType<typeof getCompanySettings>>,
  stage: DepositStage,
): { enabled: boolean; offsetDays: number; label: string } {
  switch (stage) {
    case "minus7":
      return {
        enabled: settings.reminderDepositMinus7Enabled,
        offsetDays: -settings.reminderDepositMinus7Days,
        label: "J-7 avant échéance acompte",
      };
    case "minus1":
      return {
        enabled: settings.reminderDepositMinus1Enabled,
        offsetDays: -settings.reminderDepositMinus1Days,
        label: "J-1 avant échéance acompte",
      };
    case "plus3":
      return {
        enabled: settings.reminderDepositPlus3Enabled,
        offsetDays: settings.reminderDepositPlus3Days,
        label: "J+3 après échéance acompte",
      };
    case "plus10":
      return {
        enabled: settings.reminderDepositPlus10Enabled,
        offsetDays: settings.reminderDepositPlus10Days,
        label: "J+10 après échéance acompte",
      };
  }
}

/** Enfile les rappels d'acomptes (J-7, J-1, J+3, J+10) selon PaymentMilestone.dueDate. */
export async function sendDueDepositReminders(now: Date = new Date()): Promise<number> {
  if (!(await isSmtpConfigured())) {
    console.warn("[reminders] SMTP non configuré, rappels acomptes ignorés");
    return 0;
  }

  const settings = await getCompanySettings();
  const brand = await brandFromSettings();
  const milestones = await prisma.paymentMilestone.findMany({
    where: {
      dueDate: { not: null },
      status: { notIn: [MilestoneStatus.PAID, MilestoneStatus.CANCELLED] },
      quote: {
        documentType: InvoiceDocumentType.QUOTE,
        quoteStatus: QuoteStatus.ACCEPTED,
      },
    },
    include: {
      quote: { include: { client: true } },
    },
  });

  let queued = 0;
  const today = startOfDay(now);
  const stages: DepositStage[] = ["minus7", "minus1", "plus3", "plus10"];

  for (const milestone of milestones) {
    if (!milestone.dueDate) continue;
    const due = startOfDay(milestone.dueDate);
    const to = decryptOptional(milestone.quote.client.emailEncrypted);
    if (!to) {
      console.warn(`[reminders] acompte ${milestone.id} : client sans email, ignoré`);
      continue;
    }

    for (const stage of stages) {
      const cfg = stageConfig(settings, stage);
      if (!cfg.enabled) continue;
      const triggerDay = addDays(due, cfg.offsetDays);
      if (!isSameDay(triggerDay, today)) continue;

      const kind = STAGE_KIND[stage];
      if (await alreadySent(milestone.id, kind, now)) continue;

      try {
        const built = await buildEmailContent({
          kind: "reminder_soft",
          clientName: milestone.quote.client.displayName,
          clientFirstName: milestone.quote.client.displayName.split(/\s+/)[0],
          docNumber: milestone.quote.number,
          docLabel: "acompte",
          brand,
          extraLines: [
            `Jalon : ${milestone.label}`,
            cfg.label,
            milestone.dueDate
              ? `Échéance : ${milestone.dueDate.toLocaleDateString("fr-FR")}`
              : "",
          ].filter(Boolean),
          paymentUrl: milestone.checkoutUrl,
          brandPrimaryColor: settings.brandPrimaryColor,
        });
        await mailEnqueue({
          to,
          subject: built.subject.replace("document", "acompte"),
          text: built.text,
          html: built.html,
          clientId: milestone.quote.clientId,
          documentId: milestone.id,
          documentNumber: milestone.quote.number ?? undefined,
          kind,
          bodyTextForMessage: built.text,
        });
        queued += 1;
      } catch (err) {
        console.error(`[reminders] enqueue acompte ${milestone.id} (${stage})`, err);
      }
    }
  }

  if (queued > 0) {
    console.log(`[reminders] ${queued} rappel(s) acompte enfilé(s)`);
  }
  return queued;
}
