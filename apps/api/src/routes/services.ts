import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ServiceUnit } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { eurosToCents } from "@/lib/money.js";

const serviceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  unitPriceEuros: z.coerce.number().min(0),
  unit: z.nativeEnum(ServiceUnit).default(ServiceUnit.FORFAIT),
  active: z.boolean().optional().default(true),
  isSubscription: z.boolean().optional().default(false),
  defaultBillingDay: z.coerce.number().int().min(1).max(28).optional().default(1),
});

export const servicesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/services", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const q = request.query as { active?: string; subscription?: string };
    const where: {
      active?: boolean;
      isSubscription?: boolean;
    } = {};
    if (q.active === "1") where.active = true;
    if (q.subscription === "0") where.isSubscription = false;
    if (q.subscription === "1") where.isSubscription = true;
    return prisma.service.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { name: "asc" },
    });
  });

  app.post("/api/services", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = serviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    }
    const created = await prisma.service.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        unitPriceCents: eurosToCents(parsed.data.unitPriceEuros),
        unit: parsed.data.unit,
        active: parsed.data.active,
        isSubscription: parsed.data.isSubscription,
        defaultBillingDay: parsed.data.isSubscription
          ? parsed.data.defaultBillingDay
          : 1,
      },
    });
    return reply.code(201).send(created);
  });

  app.put<{ Params: { id: string } }>("/api/services/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = serviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    }
    const updated = await prisma.service.update({
      where: { id: request.params.id },
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        unitPriceCents: eurosToCents(parsed.data.unitPriceEuros),
        unit: parsed.data.unit,
        active: parsed.data.active,
        isSubscription: parsed.data.isSubscription,
        defaultBillingDay: parsed.data.isSubscription
          ? parsed.data.defaultBillingDay
          : 1,
      },
    });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/services/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    await prisma.service.update({
      where: { id: request.params.id },
      data: { active: false },
    });
    return { ok: true };
  });
};
