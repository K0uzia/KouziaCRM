import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { sendToAll } from "@/lib/push/service.js";
import { alertAdmin } from "@/lib/stripe/alert.js";

const DAY_MS = 86_400_000;
/** Heures de nuit (heure de Paris) : aucun rappel entre 22 h et 8 h, il part au premier passage après 8 h. */
const NIGHT_FROM = 22;
const NIGHT_TO = 8;

export function isNight(now: Date): boolean {
  // formatToParts : en français, format() rend « 23 h », illisible pour Number.
  const hour = Number(
    new Intl.DateTimeFormat("fr-FR", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Paris" }).formatToParts(now).find((p) => p.type === "hour")?.value,
  );
  return hour >= NIGHT_FROM || hour < NIGHT_TO;
}

/**
 * Rappel des e-mails à valider depuis plus de 24 h (tâche planifiée, chaque heure) : un seul rappel groupé, par push
 * sur les appareils abonnés, sinon par e-mail à l'adresse de l'entreprise ; puis au plus un toutes les 24 h par e-mail.
 * @returns nombre d'e-mails rappelés.
 */
export async function remindStaleReviews(now: Date = new Date()): Promise<number> {
  if (isNight(now)) return 0;
  const cutoff = new Date(now.getTime() - DAY_MS);
  const stale = await prisma.emailOutbox.findMany({
    where: { status: EmailOutboxStatus.REVIEW, createdAt: { lte: cutoff }, OR: [{ reviewReminderAt: null }, { reviewReminderAt: { lte: cutoff } }] },
    select: { id: true, clientWaiting: true },
  });
  if (!stale.length) return 0;
  const waiting = stale.filter((r) => r.clientWaiting).length;
  const n = stale.length;
  const body = `${n > 1 ? `${n} e-mails attendent` : "1 e-mail attend"} votre validation depuis plus de 24 h${waiting ? `, dont ${waiting} où le client attend` : ""}.`;
  let pushed = 0;
  try {
    pushed = (await sendToAll({ title: "E-mails à valider", body, url: "/emails-a-valider", tag: "email-review-reminder" })).sent;
  } catch {
    pushed = 0;
  }
  if (pushed === 0) await alertAdmin("E-mails à valider", `${body}\n\nÀ valider dans l'ERP : E-mails à valider.`);
  await prisma.emailOutbox.updateMany({ where: { id: { in: stale.map((r) => r.id) } }, data: { reviewReminderAt: now } });
  return n;
}
