import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "@/lib/prisma.js";
import {
  clearSessionCookie,
  attachUser,
  createSession,
  destroySession,
  requireAuth,
  setSessionCookie,
  upgradePasswordHashIfNeeded,
  verifyPassword,
} from "@/lib/auth.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/api/auth/login",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "15 minutes",
        },
      },
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Identifiants invalides" });
      }

      const email = parsed.data.email.toLowerCase().trim();
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply.code(401).send({ error: "Email ou mot de passe incorrect" });
      }

      const ok = await verifyPassword(parsed.data.password, user.passwordHash);
      if (!ok) {
        return reply.code(401).send({ error: "Email ou mot de passe incorrect" });
      }

      await upgradePasswordHashIfNeeded(user.id, parsed.data.password, user.passwordHash);

      // Invalide les sessions expirées / rotation : une session fraîche
      await prisma.session.deleteMany({
        where: { userId: user.id, expiresAt: { lt: new Date() } },
      });

      const session = await createSession(user.id);
      setSessionCookie(reply, session.id, session.expiresAt);

      return {
        user: { id: user.id, email: user.email, name: user.name },
      };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (request.sessionId) {
      await destroySession(request.sessionId);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    await attachUser(request);
    return { user: request.user ?? null };
  });
};
