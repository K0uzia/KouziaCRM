import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@/lib/prisma.js";
import {
  clientInputSchema,
  createClientWithAccess,
  listClients,
  serializeClient,
  toPrismaClientData,
} from "@/lib/clients.js";
import { requireAuth } from "@/lib/auth.js";
import { generateAccessCode } from "@/lib/clients/numbering.js";

export const clientsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/clients", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return listClients();
  });

  app.post("/api/clients", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = clientInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { client, accessCode } = await createClientWithAccess(parsed.data);
    return reply.code(201).send({ ...client, accessCode });
  });

  app.get<{ Params: { id: string } }>("/api/clients/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const client = await prisma.client.findUnique({ where: { id: request.params.id } });
    if (!client) return reply.code(404).send({ error: "Introuvable" });
    return serializeClient(client);
  });

  app.put<{ Params: { id: string } }>("/api/clients/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = clientInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const client = await prisma.client.update({
      where: { id: request.params.id },
      data: toPrismaClientData(parsed.data),
    });
    return serializeClient(client);
  });

  app.post<{ Params: { id: string } }>(
    "/api/clients/:id/regenerate-access-code",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const access = await generateAccessCode();
      await prisma.client.update({
        where: { id: request.params.id },
        data: { accessCodeHash: access.hash },
      });
      return { accessCode: access.code };
    },
  );

  app.delete<{ Params: { id: string } }>("/api/clients/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const invoices = await prisma.invoice.count({ where: { clientId: request.params.id } });
    if (invoices > 0) {
      return reply
        .code(400)
        .send({ error: "Impossible de supprimer un client avec des factures" });
    }
    await prisma.client.delete({ where: { id: request.params.id } });
    return { ok: true };
  });
};
