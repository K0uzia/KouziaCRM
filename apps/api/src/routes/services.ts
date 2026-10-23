import { removeService, updateLinkedService } from "@/lib/services/linked-write.js";
import { packItemsSchema, packLines, packModeLine, PackError, validatePack } from "@/lib/services/packs.js";
import { BILLING_MODES } from "@/lib/quotes/payment-plans.js";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ServiceUnit } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { eurosToCents } from "@/lib/money.js";
import { StripeModeError } from "@/lib/stripe/mode.js";
import { getCompanySettings } from "@/lib/company.js";
import {
  StripeCatalogError,
  createLinkedService,
} from "@/lib/stripe/catalog-write.js";

const serviceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  unitPriceEuros: z.coerce.number().min(0),
  unit: z.nativeEnum(ServiceUnit).default(ServiceUnit.FORFAIT),
  active: z.boolean().optional().default(true),
  isSubscription: z.boolean().optional().default(false),
  defaultBillingDay: z.coerce.number().int().min(1).max(28).optional().default(1),
  /** Abonnement : périodicité du prix (Stripe actif). */
  billingInterval: z.enum(["MONTH", "YEAR"]).optional().nullable(),
  /** Clé d'idempotence Stripe : une par ouverture du formulaire. */
  requestId: z.string().uuid().optional(),
  /** Pack : prestations du catalogue avec leur quantité ; le prix est celui de la partie ponctuelle. */
  isPack: z.boolean().optional().default(false),
  /** Rubrique d'une prestation ponctuelle ; null = « Autres » (packs et abonnements : rubrique propre). */
  category: z.enum(["SITE", "LOGICIEL", "OPTION"]).optional().nullable(),
  packItems: packItemsSchema.optional(),
  /** Pack : prix annuel en paiement récurrent (vide = paiement unique seulement) ; le prix ci-dessus est le prix d'achat. */
  annualPriceEuros: z.coerce.number().min(0).optional().nullable(),
});

const packLinesQuery = z.object({
  mode: z.enum(BILLING_MODES).optional(),
  interval: z.enum(["MONTH", "QUARTER", "YEAR"]).optional().default("YEAR"),
});

const PACK_INCLUDE = {
  packItems: {
    orderBy: { position: "asc" as const },
    include: {
      service: { select: { id: true, name: true, unitPriceCents: true, isSubscription: true, billingInterval: true, active: true } },
    },
  },
};

/** Enregistre un pack (jamais dans Stripe : il n'est pas vendu tel quel, ses lignes le sont). */
async function savePack(data: z.output<typeof serviceSchema>, id?: string) {
  if (!data.packItems) throw new PackError("Un pack contient au moins une prestation.");
  const priceCents = eurosToCents(data.unitPriceEuros);
  await validatePack(data.packItems, priceCents, id);
  const fields = {
    name: data.name,
    description: data.description ?? null,
    unitPriceCents: priceCents,
    annualPriceCents: data.annualPriceEuros === null || data.annualPriceEuros === undefined ? null : eurosToCents(data.annualPriceEuros),
    unit: ServiceUnit.FORFAIT,
    active: data.active,
    isPack: true,
    isSubscription: false,
    billingInterval: null,
    defaultBillingDay: 1,
  };
  const items = data.packItems.map((i, position) => ({ serviceId: i.serviceId, quantity: i.quantity, position }));
  return prisma.$transaction(async (tx) => {
    if (id) await tx.servicePackItem.deleteMany({ where: { packId: id } });
    return id
      ? tx.service.update({ where: { id }, data: { ...fields, packItems: { create: items } }, include: PACK_INCLUDE })
      : tx.service.create({ data: { ...fields, packItems: { create: items } }, include: PACK_INCLUDE });
  });
}

function stripeError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) {
  if (err instanceof StripeCatalogError) return reply.code(502).send({ error: err.message });
  if (err instanceof StripeModeError) return reply.code(409).send({ error: err.message });
  throw err;
}

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
    const rows = await prisma.service.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { name: "asc" },
      include: { ...PACK_INCLUDE, _count: { select: { clientNeeds: true } } },
    });
    // Clients qui l'ont notée comme besoin : la suppression l'archive à la place (dit à l'écran avant de confirmer).
    return rows.map(({ _count, ...service }) => ({ ...service, clientNeedsCount: _count.clientNeeds }));
  });

  app.get<{ Params: { id: string } }>("/api/services/:id/pack-lines", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    // Devis avec mode (24/10/2026) : ?mode=ONE_OFF|RECURRING&interval=MONTH|QUARTER|YEAR, le pack en une ligne.
    const q = packLinesQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "Mode ou période invalide" });
    try {
      if (q.data.mode) return [await packModeLine(request.params.id, q.data.mode, q.data.interval)];
      return await packLines(request.params.id);
    } catch (err) {
      if (err instanceof PackError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.post("/api/services", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    const parsed = serviceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Données invalides", details: parsed.error.flatten() });
    }
    if (parsed.data.isPack) {
      try {
        return reply.code(201).send(await savePack(parsed.data));
      } catch (err) {
        if (err instanceof PackError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    }
    const settings = await getCompanySettings();
    if (settings.moduleStripeEnabled) {
      try {
        const linked0 = await createLinkedService({
          name: parsed.data.name,
          description: parsed.data.description?.trim() || null,
          unitPriceCents: eurosToCents(parsed.data.unitPriceEuros),
          isSubscription: parsed.data.isSubscription,
          billingInterval: parsed.data.billingInterval ?? null,
          defaultBillingDay: parsed.data.defaultBillingDay,
          requestId: parsed.data.requestId ?? randomUUID(),
        });
        // Rubrique : classement local, sans équivalent dans Stripe.
        const category = parsed.data.isSubscription ? null : (parsed.data.category ?? null);
        const linked = category ? await prisma.service.update({ where: { id: linked0.id }, data: { category } }) : linked0;
        return reply.code(201).send(linked);
      } catch (err) {
        return stripeError(reply, err);
      }
    }
    const created = await prisma.service.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        unitPriceCents: eurosToCents(parsed.data.unitPriceEuros),
        unit: parsed.data.unit,
        active: parsed.data.active,
        isSubscription: parsed.data.isSubscription,
        category: parsed.data.isSubscription ? null : (parsed.data.category ?? null),
        defaultBillingDay: parsed.data.isSubscription
          ? parsed.data.defaultBillingDay
          : 1,
        // Sans Stripe aussi : la périodicité choisie est gardée (sinon un abonnement annuel passait en mensuel).
        billingInterval: parsed.data.isSubscription ? (parsed.data.billingInterval ?? "MONTH") : null,
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
    const existing = await prisma.service.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.code(404).send({ error: "Prestation introuvable" });
    if (existing.isPack !== parsed.data.isPack) {
      return reply.code(400).send({ error: "Un pack reste un pack, une prestation reste une prestation : créez-en une nouvelle." });
    }
    if (existing.isPack) {
      try {
        return await savePack(parsed.data, existing.id);
      } catch (err) {
        if (err instanceof PackError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    }

    // Prestation liée à Stripe : même chemin que kouziactl catalog --stripe (lib/services/linked-write.ts).
    if (existing.stripeProductId) {
      try {
        return await updateLinkedService(
          existing,
          {
            name: parsed.data.name,
            description: parsed.data.description ?? null,
            unitPriceCents: eurosToCents(parsed.data.unitPriceEuros),
            defaultBillingDay: parsed.data.defaultBillingDay,
            category: parsed.data.category,
          },
          parsed.data.requestId ?? randomUUID(),
        );
      } catch (err) {
        return stripeError(reply, err);
      }
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
        ...(parsed.data.category !== undefined ? { category: parsed.data.isSubscription ? null : parsed.data.category } : {}),
        defaultBillingDay: parsed.data.isSubscription
          ? parsed.data.defaultBillingDay
          : 1,
        billingInterval: parsed.data.isSubscription ? (parsed.data.billingInterval ?? existing.billingInterval ?? "MONTH") : null,
      },
    });
    return updated;
  });

  // Supprime une prestation jamais utilisée ; si elle figure sur un document ou un abonnement,
  // elle est archivée (désactivée) pour ne pas altérer l'historique.
  app.delete<{ Params: { id: string } }>("/api/services/:id", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
      const result = await removeService(request.params.id);
      if (!result) return reply.code(404).send({ error: "Prestation introuvable" });
      return { ok: true, ...result };
    } catch (err) {
      return stripeError(reply, err);
    }
  });
};
