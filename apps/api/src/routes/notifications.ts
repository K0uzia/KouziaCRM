import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { listNotifications } from "@/lib/notifications/feed.js";

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function seenAtOf(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { notificationsSeenAt: true } });
  return (user?.notificationsSeenAt ?? new Date(0)).toISOString();
}

export const notificationsRoutes: FastifyPluginAsync = async (app) => {
  // ?since=ISO : événements postérieurs. Sans paramètre : les 7 derniers jours (historique de la cloche).
  // seenAt : dernière lecture, en base, pour que le PC et le téléphone affichent le même compteur.
  app.get("/api/notifications/feed", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const raw = (request.query as { since?: string }).since;
    const parsed = raw ? new Date(raw) : null;
    const since =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(Date.now() - DEFAULT_WINDOW_MS);
    return {
      items: await listNotifications(since),
      serverTime: new Date().toISOString(),
      seenAt: await seenAtOf(request.user!.id),
    };
  });

  // « Tout marquer comme lu » : horodatage serveur, toutes sortes de notifications confondues.
  app.post("/api/notifications/seen", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const user = await prisma.user.update({
      where: { id: request.user!.id },
      data: { notificationsSeenAt: new Date() },
      select: { notificationsSeenAt: true },
    });
    return { seenAt: user.notificationsSeenAt!.toISOString() };
  });
};
