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

  // Export RGPD (droit d'accès / portabilité) : toutes les données d'un client.
  app.get<{ Params: { id: string } }>(
    "/api/clients/:id/export",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const client = await prisma.client.findUnique({
        where: { id: request.params.id },
        include: {
          invoices: {
            include: {
              lines: true,
              payments: true,
            },
            orderBy: { createdAt: "asc" },
          },
          emailThreads: {
            include: { messages: true },
            orderBy: { lastMessageAt: "asc" },
          },
          subscriptions: {
            include: { service: { select: { name: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      if (!client) return reply.code(404).send({ error: "Introuvable" });

      const exportedAt = new Date().toISOString();
      reply.header("Content-Type", "application/json");
      reply.header(
        "Content-Disposition",
        `attachment; filename="client-${client.clientNumber ?? client.id}-${exportedAt.slice(0, 10)}.json"`,
      );
      return {
        exportedAt,
        client: serializeClient(client),
        invoices: client.invoices.map((inv) => ({
          id: inv.id,
          number: inv.number,
          documentType: inv.documentType,
          invoiceType: inv.invoiceType,
          status: inv.status,
          issueDate: inv.issueDate?.toISOString() ?? null,
          dueDate: inv.dueDate?.toISOString() ?? null,
          totalCents: inv.totalCents,
          lines: inv.lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            lineTotalCents: l.lineTotalCents,
          })),
          payments: inv.payments.map((p) => ({
            amountCents: p.amountCents,
            paidAt: p.paidAt.toISOString(),
            method: p.method,
            reference: p.reference,
          })),
        })),
        subscriptions: client.subscriptions.map((s) => ({
          label: s.label,
          amountCents: s.amountCents,
          billingDay: s.billingDay,
          status: s.status,
          startDate: s.startDate.toISOString(),
          endDate: s.endDate?.toISOString() ?? null,
          serviceName: s.service.name,
        })),
        emailThreads: client.emailThreads.map((t) => ({
          subject: t.subject,
          lastMessageAt: t.lastMessageAt.toISOString(),
          messages: t.messages.map((m) => ({
            direction: m.direction,
            receivedAt: m.receivedAt.toISOString(),
            subject: m.subject,
            bodyText: m.bodyText,
          })),
        })),
      };
    },
  );
};
