import { ObligationStatus } from "@prisma/client";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { getCompanySettings } from "@/lib/company.js";
import {
  officialLinkForObligationType,
  resolveOfficialLinks,
} from "@/lib/obligations/links.js";
import { prisma } from "@/lib/prisma.js";
import { dueDateYmd } from "@/lib/google-calendar/events.js";

export type ObligationEmailStage = "j7" | "j3" | "j1" | "j0";

const STAGES: Array<{ stage: ObligationEmailStage; offsetDays: number; kind: string; label: string }> =
  [
    { stage: "j7", offsetDays: -7, kind: "obligation_reminder_j7", label: "J-7" },
    { stage: "j3", offsetDays: -3, kind: "obligation_reminder_j3", label: "J-3" },
    { stage: "j1", offsetDays: -1, kind: "obligation_reminder_j1", label: "J-1" },
    { stage: "j0", offsetDays: 0, kind: "obligation_reminder_j0", label: "jour J" },
  ];

function startOfDayParis(d: Date): string {
  return dueDateYmd(d);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, day] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Target calendar day for a stage relative to due date (Paris YMD). */
export function stageTargetYmd(dueDate: Date, offsetDays: number): string {
  return addDaysYmd(dueDateYmd(dueDate), offsetDays);
}

export function buildObligationReminderEmail(opts: {
  label: string;
  stageLabel: string;
  dueYmd: string;
  officialUrl: string;
  brandName: string;
}): { subject: string; text: string; html: string } {
  const subject = `[Kouzia] Rappel ${opts.stageLabel} : ${opts.label}`;
  const text = [
    `Rappel déclaration (${opts.stageLabel})`,
    "",
    opts.label,
    `Échéance : ${opts.dueYmd}`,
    "",
    `Lien officiel : ${opts.officialUrl}`,
    "",
    `- ${opts.brandName} / KouziaCRM`,
  ].join("\n");
  const html = `<p><strong>Rappel déclaration (${opts.stageLabel})</strong></p>
<p>${escapeHtml(opts.label)}<br/>Échéance : ${escapeHtml(opts.dueYmd)}</p>
<p><a href="${escapeHtml(opts.officialUrl)}">Ouvrir la démarche officielle</a></p>
<p style="color:#64748b;font-size:12px;">${escapeHtml(opts.brandName)} / KouziaCRM</p>`;
  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Enfile les emails de rappel obligations dus aujourd'hui (J-7, J-3, J-1, jour J). */
export async function sendDueObligationEmails(now: Date = new Date()): Promise<number> {
  if (!(await isSmtpConfigured())) {
    console.warn("[obligations] SMTP non configuré, emails de rappel ignorés");
    return 0;
  }

  const settings = await getCompanySettings();
  if (!settings.obligationEmailRemindersEnabled) return 0;

  const to = settings.obligationReminderEmail?.trim();
  if (!to) return 0;

  const todayYmd = startOfDayParis(now);
  const links = resolveOfficialLinks(settings.officialLinks);
  const brandName = settings.tradeName?.trim() || settings.legalName;

  const open = await prisma.obligation.findMany({
    where: { status: { in: [ObligationStatus.PENDING, ObligationStatus.LATE] } },
  });

  let enqueued = 0;

  for (const obl of open) {
    for (const stage of STAGES) {
      const target = stageTargetYmd(obl.dueDate, stage.offsetDays);
      if (target !== todayYmd) continue;

      const already = await prisma.obligationReminderLog.findUnique({
        where: {
          obligationId_stage: { obligationId: obl.id, stage: stage.stage },
        },
      });
      if (already) continue;

      const officialUrl = officialLinkForObligationType(obl.type, links);
      const content = buildObligationReminderEmail({
        label: obl.label,
        stageLabel: stage.label,
        dueYmd: dueDateYmd(obl.dueDate),
        officialUrl,
        brandName,
      });

      await mailEnqueue({
        to,
        subject: content.subject,
        text: content.text,
        html: content.html,
        kind: stage.kind,
      });

      await prisma.obligationReminderLog.create({
        data: { obligationId: obl.id, stage: stage.stage },
      });
      enqueued += 1;
    }
  }

  return enqueued;
}
