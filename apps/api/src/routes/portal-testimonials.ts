import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { resolvePortalSession } from "@/lib/portal/auth.js";
import { siteText } from "@/lib/site/contract.js";
import {
  AUTHOR_FORMATS,
  CONSENT_VERSION,
  submitTestimonial,
  TESTIMONIAL_MAX_LENGTH,
  TestimonialError,
  testimonialState,
  withdrawTestimonial,
} from "@/lib/site/testimonials.js";

/**
 * Témoignage d'un projet terminé, depuis l'espace client (/suivi) : session du portail obligatoire,
 * le client vient de la session (jamais du corps). Format convenu avec KouziaWebsite (README du site).
 */
const SESSION_EXPIRED = { error: "Session expirée : reconnectez-vous." };
const params = z.object({ projectId: z.string().min(1).max(64) });
const body = z.strictObject({
  text: siteText.max(TESTIMONIAL_MAX_LENGTH),
  authorFormat: z.enum(AUTHOR_FORMATS),
  consent: z.literal(true, { error: "Accord requis pour publier le témoignage." }),
  consentVersion: z.literal(CONSENT_VERSION, { error: "Texte d'accord périmé : rechargez la page." }),
});

const fail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof TestimonialError) return reply.code(e.status).send({ error: e.message });
  throw e;
};

export const portalTestimonialsRoutes: FastifyPluginAsync = async (app) => {
  app.put(
    "/api/public/portal/projects/:projectId/testimonial",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const session = await resolvePortalSession(request);
      if (!session) return reply.code(401).send(SESSION_EXPIRED);
      const p = params.safeParse(request.params);
      const b = body.safeParse(request.body);
      if (!p.success) return reply.code(404).send({ error: "Projet introuvable." });
      if (!b.success) {
        return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Données invalides", issues: b.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
      }
      try {
        const row = await submitTestimonial({
          client: session.client,
          sessionId: session.sessionId,
          projectId: p.data.projectId,
          text: b.data.text,
          authorFormat: b.data.authorFormat,
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        });
        return { status: testimonialState(row), text: row.text, authorFormat: row.authorFormat };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  app.delete(
    "/api/public/portal/projects/:projectId/testimonial",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const session = await resolvePortalSession(request);
      if (!session) return reply.code(401).send(SESSION_EXPIRED);
      const p = params.safeParse(request.params);
      if (!p.success) return reply.code(404).send({ error: "Projet introuvable." });
      try {
        const result = await withdrawTestimonial(session.client.id, p.data.projectId);
        return { status: result === "deleted" ? "none" : "withdrawn" };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
};
