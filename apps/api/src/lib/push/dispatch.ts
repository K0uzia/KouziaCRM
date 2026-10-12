import { prisma } from "@/lib/prisma.js";
import { listNotifications, type NotificationKind } from "@/lib/notifications/feed.js";
import { sendToAll } from "@/lib/push/service.js";
import { vapidStatus } from "@/lib/push/vapid.js";

/** Événements envoyés en push (la cloche reste la source unique). */
export const PUSHED_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "quote_accepted",
  "quote_rejected",
  "payment",
  "mail",
  "client_onboarded",
  "subscription_stripe",
]);

/**
 * Envoie les événements apparus depuis le dernier passage (worker, toutes les 30 s).
 * Premier passage, ou aucun appareil abonné : le repère avance sans rien envoyer
 * (pas d'historique en rafale à l'activation).
 * @returns nombre de notifications envoyées.
 */
export async function dispatchPushNotifications(now: Date = new Date()): Promise<number> {
  if (!vapidStatus().config) return 0;
  const settings = await prisma.companySettings.findFirst({ select: { id: true, pushDispatchedAt: true } });
  if (!settings) return 0;
  const devices = await prisma.pushSubscription.count();
  if (!settings.pushDispatchedAt || devices === 0) {
    await prisma.companySettings.update({ where: { id: settings.id }, data: { pushDispatchedAt: now } });
    return 0;
  }

  const items = await listNotifications(settings.pushDispatchedAt);
  if (items.length === 0) return 0;
  let sent = 0;
  for (const item of [...items].reverse()) {
    if (!PUSHED_KINDS.has(item.kind)) continue;
    const report = await sendToAll({ title: item.title, body: item.body, url: item.href, tag: item.id });
    sent += report.sent;
  }
  // Repère : le plus récent des événements lus (la cloche ne renvoie que ce qui est postérieur).
  const latest = items.reduce((max, i) => (i.at > max ? i.at : max), items[0]!.at);
  await prisma.companySettings.update({ where: { id: settings.id }, data: { pushDispatchedAt: new Date(latest) } });
  return sent;
}
