import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { requireAuth } from "@/lib/auth.js";
import {
  createClientProject,
  deleteClientProject,
  listClientProjects,
  ProjectError,
  projectInputSchema,
  updateClientProject,
} from "@/lib/projects/service.js";

function projectError(reply: FastifyReply, e: unknown) {
  if (e instanceof ProjectError) {
    return reply.code(e.statusCode).send({ error: e.message });
  }
  throw e;
}

function invalidInput(reply: FastifyReply, issues: { message: string }[]) {
  return reply.code(400).send({ error: issues[0]?.message ?? "Données invalides" });
}

export const projectsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>("/api/clients/:id/projects", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return listClientProjects(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/clients/:id/projects", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = projectInputSchema.safeParse(request.body);
    if (!parsed.success) return invalidInput(reply, parsed.error.issues);
    try {
      return await createClientProject(request.params.id, parsed.data);
    } catch (e) {
      return projectError(reply, e);
    }
  });

  app.put<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const parsed = projectInputSchema.safeParse(request.body);
      if (!parsed.success) return invalidInput(reply, parsed.error.issues);
      try {
        return await updateClientProject(request.params.projectId, parsed.data);
      } catch (e) {
        return projectError(reply, e);
      }
    },
  );

  app.delete<{ Params: { projectId: string } }>(
    "/api/projects/:projectId",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      try {
        await deleteClientProject(request.params.projectId);
        return { ok: true };
      } catch (e) {
        return projectError(reply, e);
      }
    },
  );
};
