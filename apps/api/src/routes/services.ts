import { packItemsSchema, packLines, PackError, validatePack } from "@/lib/services/packs.js";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ServiceUnit } from "@prisma/client";
import { requireAuth } from "@/lib/auth.js";
import { prisma } from "@/lib/prisma.js";
import { eurosToCents } from "@/lib/money.js";
import { getStripe } from "@/lib/stripe/client.js";
import { StripeModeError, assertSameMode } from "@/lib/stripe/mode.js";
import { getCompanySettings } from "@/lib/company.js";
import {
  StripeCatalogError,
  archiveLinkedService,
  changeLinkedServicePrice,
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
  packItems: packItemsSchema.optional(),
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
    return prisma.service.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { name: "asc" },
      include: PACK_INCLUDE,
    });
  });

  app.get<{ Params: { id: string } }>("/api/services/:id/pack-lines", async (request, reply) => {
    await requireAuth(request, reply);
    if (reply.sent) return;
    try {
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
        const linked = await createLinkedService({
          name: parsed.data.name,
          description: parsed.data.description?.trim() || null,
          unitPriceCents: eurosToCents(parsed.data.unitPriceEuros),
          isSubscription: parsed.data.isSubscription,
          billingInterval: parsed.data.billingInterval ?? null,
          defaultBillingDay: parsed.data.defaultBillingDay,
          requestId: parsed.data.requestId ?? randomUUID(),
        });
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

    // Prestation liée à Stripe : type et périodicité appartiennent au prix Stripe (lecture seule).
    // Nom et description sont repoussés vers le produit Stripe, sinon la synchro horaire les écraserait ;
    // un nouveau montant crée un nouveau prix Stripe (les abonnements en cours gardent l'ancien).
    if (existing.stripeProductId) {
      try {
        await assertSameMode(existing.stripeLivemode, "Cette prestation");
      } catch (e) {
        if (e instanceof StripeModeError) return reply.code(409).send({ error: e.message });
        throw e;
      }
      try {
        const stripe = await getStripe();
        await stripe.products.update(existing.stripeProductId, {
          name: parsed.data.name.replace(/\s*\(annuel\)\s*$/i, "").trim(),
          description: parsed.data.description?.trim() || "",
        });
      } catch (e) {
        return reply.code(502).send({
          error: `Stripe n'a pas accepté la modification : ${e instanceof Error ? e.message : "erreur"}`,
        });
      }
      const newCents = eurosToCents(parsed.data.unitPriceEuros);
      let stripePriceId = existing.stripePriceId;
      if (newCents !== existing.unitPriceCents && existing.stripePriceId) {
        try {
          stripePriceId = await changeLinkedServicePrice(existing, newCents, parsed.data.requestId ?? randomUUID());
        } catch (err) {
          // Rien d'appliqué à moitié : le produit Stripe reprend son nom, l'ERP n'a pas changé.
          try {
            const stripe = await getStripe();
            await stripe.products.update(existing.stripeProductId, {
              name: existing.name.replace(/\s*\(annuel\)\s*$/i, "").trim(),
              description: existing.description?.trim() || "",
            });
          } catch {
            // Nom non rétabli : la synchro horaire (Stripe vers l'ERP) le reprendrait ; l'admin est prévenu.
            if (err instanceof StripeCatalogError) {
              return reply.code(502).send({
                error: `${err.message} Le nouveau nom est resté dans Stripe : remettez l'ancien dans Stripe ou réessayez la modification.`,
              });
            }
          }
          return stripeError(reply, err);
        }
      }
      return prisma.service.update({
        where: { id: existing.id },
        data: {
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          defaultBillingDay: existing.isSubscription ? parsed.data.defaultBillingDay : 1,
          unitPriceCents: newCents,
          stripePriceId,
        },
      });
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
    const id = request.params.id;
    const service = await prisma.service.findUnique({
      where: { id },
      include: { _count: { select: { invoiceLines: true, subscriptions: true, inPacks: true } } },
    });
    if (!service) return reply.code(404).send({ error: "Prestation introuvable" });
    if (service.stripeProductId) {
      try {
        await assertSameMode(service.stripeLivemode, "Cette prestation");
        await archiveLinkedService(service);
      } catch (err) {
        return stripeError(reply, err);
      }
    }
    // Prestation d'un pack : archivée (le pack garde son détail) ; un pack lui-même ne figure sur aucune ligne.
    if (service._count.invoiceLines > 0 || service._count.subscriptions > 0 || service._count.inPacks > 0) {
      await prisma.service.update({ where: { id }, data: { active: false } });
      return { ok: true, archived: true };
    }
    await prisma.service.delete({ where: { id } });
    return { ok: true, archived: false };
  });
};
