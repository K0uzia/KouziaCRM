import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "@/lib/auth.js";
import { listNotifications } from "@/lib/notifications/feed.js";

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const notificationsRoutes: FastifyPluginAsync = async (app) => {
  // ?since=ISO : événements postérieurs. Sans paramètre : les 7 derniers jours (historique de la cloche).
  app.get("/api/notifications/feed", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const raw = (request.query as { since?: string }).since;
    const parsed = raw ? new Date(raw) : null;
    const since =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(Date.now() - DEFAULT_WINDOW_MS);
    return { items: await listNotifications(since), serverTime: new Date().toISOString() };
  });
};
