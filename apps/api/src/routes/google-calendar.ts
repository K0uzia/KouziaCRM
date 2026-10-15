import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "@/lib/auth.js";
import { getCompanySettings } from "@/lib/company.js";
import { isGoogleCalendarConfigured, webAdminOrigin } from "@/lib/google-calendar/config.js";
import {
  createOAuthState,
  resolveReturnOrigin,
  verifyOAuthState,
} from "@/lib/google-calendar/oauth-state.js";
import {
  disconnectGoogleCalendar,
  exchangeGoogleCode,
  getGoogleAuthUrl,
  isGoogleCalendarConnected,
} from "@/lib/google-calendar/oauth.js";
import { formatGoogleApiError } from "@/lib/google-calendar/events.js";
import { syncObligations, syncObligationsApresModification } from "@/lib/obligations/obligation-service.js";

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
      // Google a refusé le jeton : bandeau « à reconnecter » dans Réglages > Fiscalité.
      reauthRequiredAt: settings.googleCalendarReauthRequiredAt?.toISOString() ?? null,
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
    // L'admin revient là d'où il est parti (LAN, erp. ou Tailscale), dans la liste blanche.
    const { returnTo } = request.query as { returnTo?: string };
    return { url: getGoogleAuthUrl(createOAuthState(resolveReturnOrigin(returnTo))) };
  });

  /**
   * Callback OAuth : pas de requireAuth (redirect navigateur Google).
   * Après échange du code : régénère les obligations (toutes les dates de
   * déclaration) puis crée / met à jour les événements Google avant redirect.
   */
  app.get("/api/google/calendar/callback", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const q = request.query as { code?: string; error?: string; state?: string };
    const origin = verifyOAuthState(q.state);
    if (!origin) {
      // State absent, falsifié ou expiré : aucun échange de code (connexion non demandée par l'admin).
      return reply.redirect(`${webAdminOrigin()}/settings?tab=declarations&google=error`);
    }
    const base = `${origin}/settings?tab=declarations`;
    if (q.error) {
      return reply.redirect(`${base}&google=error`);
    }
    if (!q.code?.trim()) {
      return reply.redirect(`${base}&google=error`);
    }
    try {
      await exchangeGoogleCode(q.code.trim());
      // Échéances ajoutées à l'agenda en arrière-plan : plusieurs appels Google par obligation, en série.
      await syncObligationsApresModification();
      return reply.redirect(`${base}&google=ok&sync=pending`);
    } catch (err) {
      console.error("[google-calendar] OAuth callback failed :", formatGoogleApiError(err));
      return reply.redirect(`${base}&google=error`);
    }
  });

  app.post("/api/google/calendar/disconnect", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    await disconnectGoogleCalendar();
    return { ok: true };
  });

  /** Régénère les obligations puis aligne Google Calendar. */
  app.post("/api/google/calendar/sync", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const result = await syncObligations();
    if (result.error) {
      return reply.code(502).send({ error: result.error, ...result });
    }
    return result;
  });
};
