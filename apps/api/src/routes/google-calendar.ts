import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "@/lib/auth.js";
import { getCompanySettings } from "@/lib/company.js";
import {
  isGoogleCalendarConfigured,
  webAdminOrigin,
} from "@/lib/google-calendar/config.js";
import {
  disconnectGoogleCalendar,
  exchangeGoogleCode,
  getGoogleAuthUrl,
  isGoogleCalendarConnected,
} from "@/lib/google-calendar/oauth.js";
import { reconcileObligationCalendarEvents } from "@/lib/google-calendar/reconcile.js";

export const googleCalendarRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/google/calendar/status", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const settings = await getCompanySettings();
    const configured = isGoogleCalendarConfigured();
    const connected = configured && (await isGoogleCalendarConnected());
    return {
      configured,
      connected,
      enabled: settings.googleCalendarEnabled,
      email: settings.googleCalendarConnectedEmail,
    };
  });

  app.get("/api/google/calendar/auth-url", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    if (!isGoogleCalendarConfigured()) {
      return reply.code(503).send({
        error:
          "Google Calendar non configuré (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)",
      });
    }
    return { url: getGoogleAuthUrl() };
  });

  /** Callback OAuth : pas de requireAuth (redirect navigateur Google). */
  app.get("/api/google/calendar/callback", async (request, reply) => {
    const q = request.query as { code?: string; error?: string };
    const base = `${webAdminOrigin()}/settings?tab=declarations`;
    if (q.error) {
      return reply.redirect(`${base}&google=error`);
    }
    if (!q.code?.trim()) {
      return reply.redirect(`${base}&google=error`);
    }
    try {
      await exchangeGoogleCode(q.code.trim());
      void reconcileObligationCalendarEvents();
      return reply.redirect(`${base}&google=ok`);
    } catch (err) {
      console.error("[google-calendar] OAuth callback failed", err);
      return reply.redirect(`${base}&google=error`);
    }
  });

  app.post("/api/google/calendar/disconnect", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    await disconnectGoogleCalendar();
    return { ok: true };
  });

  app.post("/api/google/calendar/sync", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const result = await reconcileObligationCalendarEvents();
    if (result.error) {
      return reply.code(502).send({ error: result.error, ...result });
    }
    return result;
  });
};
