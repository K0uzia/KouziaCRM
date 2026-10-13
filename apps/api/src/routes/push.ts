import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { vapidStatus } from "@/lib/push/vapid.js";
import { PushDisabledError, sendToUser } from "@/lib/push/service.js";

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000).startsWith("https://"),
  keys: z.object({
    p256dh: z.string().min(16).max(200),
    auth: z.string().min(8).max(100),
  }),
  label: z.string().trim().min(1).max(80),
});

/** Notifications push : clé publique, abonnement de l'appareil, liste et retrait, test. */
export const pushRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/push/config", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const { config, reason } = vapidStatus();
    return config ? { enabled: true, publicKey: config.publicKey } : { enabled: false, reason };
  });

  app.get("/api/push/subscriptions", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return prisma.pushSubscription.findMany({
      where: { userId: request.user!.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, endpoint: true, label: true, createdAt: true, lastSuccessAt: true, lastErrorAt: true, lastError: true },
    });
  });

  app.post("/api/push/subscriptions", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (!vapidStatus().config) return reply.code(503).send({ error: "Notifications push désactivées sur le serveur (clés VAPID absentes)." });
    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Abonnement invalide" });
    const { endpoint, keys, label } = parsed.data;
    // Même appareil réabonné (clés renouvelées par le navigateur) : mise à jour, pas de doublon.
    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId: request.user!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, label },
      update: { userId: request.user!.id, p256dh: keys.p256dh, auth: keys.auth, label, lastError: null },
      select: { id: true, label: true, createdAt: true },
    });
    return reply.code(201).send(sub);
  });

  app.delete<{ Params: { id: string } }>("/api/push/subscriptions/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const { count } = await prisma.pushSubscription.deleteMany({ where: { id: request.params.id, userId: request.user!.id } });
    if (count === 0) return reply.code(404).send({ error: "Appareil introuvable" });
    return { ok: true };
  });

  app.post("/api/push/test", { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } }, async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const report = await sendToUser(request.user!.id, {
        title: "Kouzia ERP",
        body: "Notification de test : les notifications arrivent bien sur cet appareil.",
        url: "/settings?tab=notifications",
        tag: `test:${Date.now()}`,
      });
      if (report.sent === 0) {
        return reply.code(409).send({
          error: report.removed > 0
            ? "Cet appareil n'est plus abonné (abonnement expiré) : réactivez les notifications."
            : "Aucun appareil n'a reçu la notification de test.",
          ...report,
        });
      }
      return report;
    } catch (err) {
      if (err instanceof PushDisabledError) return reply.code(503).send({ error: err.message });
      throw err;
    }
  });
};
