import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "@/lib/auth.js";
import {
  listAdminTestimonials,
  publishTestimonial,
  rejectTestimonial,
  TestimonialError,
  unpublishTestimonial,
} from "@/lib/testimonials/service.js";

export const testimonialsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/testimonials", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return listAdminTestimonials();
  });

  app.post<{ Params: { id: string } }>(
    "/api/testimonials/:id/publish",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      try {
        return await publishTestimonial(request.params.id);
      } catch (e) {
        if (e instanceof TestimonialError) {
          return reply.code(e.statusCode).send({ error: e.message });
        }
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/testimonials/:id/unpublish",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      try {
        return await unpublishTestimonial(request.params.id);
      } catch (e) {
        if (e instanceof TestimonialError) {
          return reply.code(e.statusCode).send({ error: e.message });
        }
        throw e;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/testimonials/:id/reject",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      try {
        return await rejectTestimonial(request.params.id);
      } catch (e) {
        if (e instanceof TestimonialError) {
          return reply.code(e.statusCode).send({ error: e.message });
        }
        throw e;
      }
    },
  );
};
