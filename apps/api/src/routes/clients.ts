import type { FastifyPluginAsync } from "fastify";
import { prisma } from "@/lib/prisma.js";
import {
  AddressValidationError,
  clientInputSchema,
  createClientWithAccess,
  listClients,
  serializeClient,
  toPrismaClientData,
} from "@/lib/clients.js";
import { requireAuth } from "@/lib/auth.js";
import { issueAndSendAccessCode } from "@/lib/clients/access-email.js";
import { sendOnboardingInvite } from "@/lib/clients/onboarding.js";
import { replyEntrepriseLookup } from "@/lib/company/entreprise-route.js";

export const clientsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/clients", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { hasCorrespondence?: string };
    const hasCorrespondence =
      q.hasCorrespondence === "true"
        ? true
        : q.hasCorrespondence === "false"
          ? false
          : undefined;
    return listClients({ hasCorrespondence });
  });

  app.post("/api/clients", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = clientInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const { client } = await createClientWithAccess(parsed.data);
      return reply.code(201).send(client);
    } catch (e) {
      if (e instanceof AddressValidationError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
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
    try {
      const client = await prisma.client.update({
        where: { id: request.params.id },
        data: await toPrismaClientData(parsed.data),
      });
      return serializeClient(client);
    } catch (e) {
      if (e instanceof AddressValidationError) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
  });

  app.get<{ Params: { siren: string } }>(
    "/api/entreprises/:siren",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      return replyEntrepriseLookup(request.params.siren, reply);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/clients/:id/regenerate-access-code",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const existing = await prisma.client.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) return reply.code(404).send({ error: "Introuvable" });

      try {
        const result = await issueAndSendAccessCode(existing.id);
        return result;
      } catch (e) {
        return reply
          .code(400)
          .send({ error: e instanceof Error ? e.message : "Impossible de générer le code" });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/clients/:id/onboarding/invite",
    async (request, reply) => {
      await requireAuth(request, reply);
      if (reply.sent) return;
      const existing = await prisma.client.findUnique({
        where: { id: request.params.id },
      });
      if (!existing) return reply.code(404).send({ error: "Introuvable" });
      const body = (request.body ?? {}) as { email?: string };
      const email = (body.email ?? "").trim();
      if (!email) return reply.code(400).send({ error: "Email requis" });
      try {
        const result = await sendOnboardingInvite({ email, existingClientId: existing.id });
        return result;
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : "Erreur" });
      }
    },
  );

  app.post("/api/onboarding/invite", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const body = (request.body ?? {}) as { email?: string };
    const email = (body.email ?? "").trim();
    if (!email) return reply.code(400).send({ error: "Email requis" });
    try {
      const result = await sendOnboardingInvite({ email, existingClientId: null });
      return result;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : "Erreur" });
    }
  });

  app.get<{ Params: { id: string } }>("/api/clients/:id/emails", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const client = await prisma.client.findUnique({ where: { id: request.params.id } });
    if (!client) return reply.code(404).send({ error: "Introuvable" });

    const [threads, events] = await Promise.all([
      prisma.emailThread.findMany({
        where: { clientId: client.id },
        orderBy: { lastMessageAt: "desc" },
        take: 50,
        include: {
          messages: {
            orderBy: { receivedAt: "desc" },
            take: 1,
            select: { direction: true },
          },
        },
      }),
      prisma.clientEmailEvent.findMany({
        where: { clientId: client.id },
        orderBy: { sentAt: "desc" },
        take: 50,
      }),
    ]);

    const items = [
      ...threads.map((t) => ({
        id: `thread-${t.id}`,
        kind: "thread" as const,
        at: t.lastMessageAt.toISOString(),
        subject: t.subject,
        direction: t.messages[0]?.direction,
        threadId: t.id,
      })),
      ...events.map((e) => ({
        id: `event-${e.id}`,
        kind: "event" as const,
        at: e.sentAt.toISOString(),
        subject: e.subject,
        eventKind: e.kind,
        documentId: e.documentId,
        documentNumber: e.documentNumber,
        success: e.success,
        threadId: e.threadId ?? undefined,
      })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return { items };
  });

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
