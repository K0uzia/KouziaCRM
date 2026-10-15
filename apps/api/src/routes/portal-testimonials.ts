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
const SESSION_EXPIRED = { error: "SESSION_EXPIRED", message: "Session expirée : reconnectez-vous." };
const params = z.object({ projectId: z.string().min(1).max(64) });
const body = z.strictObject({
  text: z.string(),
  nameMode: z.string(),
  consent: z.unknown(),
  consentVersion: z.unknown(),
});

/** Corps vérifié champ par champ : un code stable par cas, traduit par le site. */
function checkBody(raw: unknown):
  | { ok: true; text: string; nameMode: (typeof AUTHOR_FORMATS)[number] }
  | { ok: false; code: string } {
  const b = body.safeParse(raw);
  if (!b.success) return { ok: false, code: "INVALID" };
  const text = b.data.text.trim();
  if (!text) return { ok: false, code: "TEXT_EMPTY" };
  if (text.length > TESTIMONIAL_MAX_LENGTH) return { ok: false, code: "TEXT_TOO_LONG" };
  // Charte du site : pas de tiret cadratin ni demi-cadratin (le site refuserait le fichier).
  if (!siteText.safeParse(text).success) return { ok: false, code: "TEXT_INVALID" };
  if (b.data.consent !== true) return { ok: false, code: "CONSENT_REQUIRED" };
  if (b.data.consentVersion !== CONSENT_VERSION) return { ok: false, code: "CONSENT_OUTDATED" };
  if (!(AUTHOR_FORMATS as readonly string[]).includes(b.data.nameMode)) return { ok: false, code: "NAME_MODE_INVALID" };
  return { ok: true, text, nameMode: b.data.nameMode as (typeof AUTHOR_FORMATS)[number] };
}

const fail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof TestimonialError) return reply.code(e.status).send({ error: e.code, message: e.message });
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
      if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
      const b = checkBody(request.body);
      if (!b.ok) return reply.code(400).send({ error: b.code });
      try {
        const row = await submitTestimonial({
          client: session.client,
          sessionId: session.sessionId,
          projectId: p.data.projectId,
          text: b.text,
          authorFormat: b.nameMode,
          ip: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
        });
        return { status: testimonialState(row), text: row.text, nameMode: row.authorFormat };
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
      if (!p.success) return reply.code(404).send({ error: "NOT_FOUND" });
      try {
        const result = await withdrawTestimonial(session.client.id, p.data.projectId);
        return { status: result === "deleted" ? "NONE" : "WITHDRAWN" };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );
};
