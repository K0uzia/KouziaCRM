import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { PushSubscription } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { vapidStatus } from "@/lib/push/vapid.js";

/** Contenu d'une notification (titre, texte court, écran à ouvrir). Aucun extrait de message. */
export type PushPayload = { title: string; body: string; url: string; tag?: string };

export type SendReport = { sent: number; failed: number; removed: number };

export class PushDisabledError extends Error {
  statusCode = 503;
}

/** Envoi à un appareil. 404/410 : l'abonnement n'existe plus côté navigateur, il est supprimé. */
async function sendOne(sub: PushSubscription, payload: PushPayload): Promise<"ok" | "gone" | "error"> {
  const { config } = vapidStatus();
  if (!config) throw new PushDisabledError("Notifications push désactivées : clés VAPID absentes.");
  try {
    // Chiffrement aes128gcm (RFC 8291) et en-tête VAPID (RFC 8292), acceptés par tous les services push.
    const req = await buildPushPayload(
      { data: payload, options: { ttl: 24 * 3600, urgency: "high", ...(payload.tag ? { topic: topicOf(payload.tag) } : {}) } },
      { endpoint: sub.endpoint, expirationTime: null, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      config,
    );
    const res = await fetch(sub.endpoint, req);
    if (res.ok) {
      await prisma.pushSubscription.update({ where: { id: sub.id }, data: { lastSuccessAt: new Date(), lastError: null } });
      return "ok";
    }
    if (res.status === 404 || res.status === 410) {
      await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
      return "gone";
    }
    await prisma.pushSubscription.update({
      where: { id: sub.id },
      data: { lastErrorAt: new Date(), lastError: `HTTP ${res.status}` },
    });
    return "error";
  } catch (err) {
    await prisma.pushSubscription
      .update({ where: { id: sub.id }, data: { lastErrorAt: new Date(), lastError: err instanceof Error ? err.message.slice(0, 200) : "erreur" } })
      .catch(() => undefined);
    return "error";
  }
}

/** Sujet de remplacement (32 caractères base64url au plus) : un même événement ne s'empile pas. */
function topicOf(tag: string): string {
  return Buffer.from(tag).toString("base64url").slice(0, 32);
}

async function sendMany(subs: PushSubscription[], payload: PushPayload): Promise<SendReport> {
  const report: SendReport = { sent: 0, failed: 0, removed: 0 };
  for (const sub of subs) {
    const r = await sendOne(sub, payload);
    if (r === "ok") report.sent += 1;
    else if (r === "gone") report.removed += 1;
    else report.failed += 1;
  }
  return report;
}

export async function sendToUser(userId: string, payload: PushPayload): Promise<SendReport> {
  return sendMany(await prisma.pushSubscription.findMany({ where: { userId } }), payload);
}

/** ERP mono-utilisateur : les événements vont à tous les appareils abonnés. */
export async function sendToAll(payload: PushPayload): Promise<SendReport> {
  return sendMany(await prisma.pushSubscription.findMany(), payload);
}
