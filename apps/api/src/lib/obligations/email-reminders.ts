import { ObligationStatus, type CompanySettings } from "@prisma/client";
import { renderEmailHtml, type EmailLayoutBrand } from "@/lib/email/layout.js";
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

/**
 * Rappel d'obligation : même mise en page et même pied légal que les autres e-mails (layout.ts).
 * Le texte brut est la source ; le HTML en dérive, le lien officiel y devient un bouton.
 * Le pied de la partie texte est ajouté à l'envoi (processor), comme pour tout e-mail automatique.
 */
export function buildObligationReminderEmail(opts: {
  label: string;
  stageLabel: string;
  dueYmd: string;
  officialUrl: string;
  brand: EmailLayoutBrand;
  colors?: Partial<Pick<CompanySettings, "brandPrimaryColor" | "brandSecondaryColor">> | null;
}): { subject: string; text: string; html: string } {
  const brandName = opts.brand.tradeName?.trim() || opts.brand.legalName;
  const subject = `[Kouzia] Rappel ${opts.stageLabel} : ${opts.label}`;
  const text = [
    `Rappel déclaration (${opts.stageLabel})`,
    "",
    opts.label,
    `Échéance : ${opts.dueYmd}`,
    "",
    `Lien officiel : ${opts.officialUrl}`,
    "",
    `- ${brandName} / Kouzia ERP`,
  ].join("\n");
  const html = renderEmailHtml({
    text,
    brand: opts.brand,
    colors: opts.colors,
    paymentUrl: opts.officialUrl,
    paymentLabel: "Ouvrir la démarche officielle",
  });
  return { subject, text, html };
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
  const brand: EmailLayoutBrand = {
    tradeName: settings.tradeName ?? settings.legalName,
    legalName: settings.legalName,
    siret: settings.siret,
    addressLine1: settings.addressLine1,
    postalCode: settings.postalCode,
    city: settings.city,
    website: settings.website,
  };

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
        brand,
        colors: settings,
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
