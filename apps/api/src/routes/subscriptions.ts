import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { SubscriptionStatus } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import {
  createSubscription,
  listSubscriptions,
  getSubscription,
  updateSubscription,
  pauseSubscription,
  resumeSubscription,
  endSubscription,
  computeMrrCents,
  generateDueSubscriptionInvoices,
  createSubscriptionRevision,
  SubscriptionError,
} from "@/lib/subscriptions/subscription-service.js";

const createSchema = z.object({
  clientId: z.string().min(1),
  serviceId: z.string().min(1),
  label: z.string().min(1).max(200),
  amountEuros: z.coerce.number().min(0.01),
  billingDay: z.number().int().min(1).max(28),
  startDate: z.string().optional(),
  endDate: z.string().optional().nullable(),
});

const patchSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  billingDay: z.number().int().min(1).max(28).optional(),
  endDate: z.string().optional().nullable(),
});

function toCents(euros: number): number {
  return Math.round(euros * 100);
}

function parseDate(value: string | undefined | null): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return new Date(value);
}

export const subscriptionsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/subscriptions", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { status?: string };
    const status = q.status
      ? (Object.values(SubscriptionStatus).find((s) => s === q.status) as SubscriptionStatus | undefined)
      : undefined;
    return listSubscriptions(status);
  });

  app.get("/api/subscriptions/mrr", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    return computeMrrCents();
  });

  app.post("/api/subscriptions", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const sub = await createSubscription({
        clientId: parsed.data.clientId,
        serviceId: parsed.data.serviceId,
        label: parsed.data.label,
        amountCents: toCents(parsed.data.amountEuros),
        billingDay: parsed.data.billingDay,
        startDate: parsed.data.startDate ? new Date(parsed.data.startDate) : new Date(),
        endDate: parseDate(parsed.data.endDate),
      });
      return reply.code(201).send(sub);
    } catch (err) {
      if (err instanceof SubscriptionError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/api/subscriptions/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const sub = await getSubscription(request.params.id);
    if (!sub) return reply.code(404).send({ error: "Introuvable" });
    return sub;
  });

  app.patch<{ Params: { id: string } }>("/api/subscriptions/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const sub = await updateSubscription(request.params.id, {
        label: parsed.data.label,
        amountCents: undefined,
        billingDay: parsed.data.billingDay,
        endDate: parseDate(parsed.data.endDate),
      });
      return sub;
    } catch (err) {
      if (err instanceof SubscriptionError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/pause", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const sub = await pauseSubscription(request.params.id);
    return sub;
  });

  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/resume", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const sub = await resumeSubscription(request.params.id);
      return sub;
    } catch (err) {
      if (err instanceof SubscriptionError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/end", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const body = request.body as { endDate?: string } | null;
    const sub = await endSubscription(request.params.id, body?.endDate ? new Date(body.endDate) : undefined);
    return sub;
  });

  // Révision légale : émet un devis d'avenant au nouveau montant (envoyé au client).
  // L'abonnement est mis à jour + facture émise à l'acceptation du devis.
  app.post<{ Params: { id: string } }>("/api/subscriptions/:id/revise", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const schema = z.object({
      amountEuros: z.coerce.number().min(0.01),
      label: z.string().min(1).max(200).optional(),
      billingDay: z.number().int().min(1).max(28).optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const result = await createSubscriptionRevision({
        subscriptionId: request.params.id,
        amountCents: toCents(parsed.data.amountEuros),
        label: parsed.data.label,
        billingDay: parsed.data.billingDay,
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof SubscriptionError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  // Déclenchement manuel de la génération (utile pour tester sans attendre le cron).
  app.post("/api/subscriptions/run-due", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const generated = await generateDueSubscriptionInvoices();
    return { generated };
  });
};
