import type { Service } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getStripe } from "@/lib/stripe/client.js";
import { assertSameMode } from "@/lib/stripe/mode.js";
import { archiveLinkedService, changeLinkedServicePrice, StripeCatalogError } from "@/lib/stripe/catalog-write.js";

/**
 * Écritures d'une prestation liée à Stripe, partagées par la route PUT/DELETE /api/services/:id et par
 * `kouziactl catalog --stripe` : un seul chemin de code. Stripe d'abord ; s'il échoue, l'ERP ne change pas
 * (StripeCatalogError, 502 ; StripeModeError, 409).
 */

export type LinkedServiceUpdate = {
  name: string;
  description: string | null;
  unitPriceCents: number;
  defaultBillingDay: number;
  /** undefined : rubrique inchangée. */
  category?: string | null;
};

/** Nom du produit Stripe : celui de l'ERP sans le suffixe « (annuel) » ajouté pour les offres annuelles. */
const productName = (name: string) => name.replace(/\s*\(annuel\)\s*$/i, "").trim();

/**
 * Prestation liée : type et périodicité appartiennent au prix Stripe (lecture seule). Nom et description sont
 * repoussés vers le produit Stripe, sinon la synchro horaire les écraserait ; un nouveau montant crée un nouveau
 * prix Stripe et archive l'ancien (les abonnements en cours gardent l'ancien prix).
 */
export async function updateLinkedService(existing: Service, input: LinkedServiceUpdate, requestId: string): Promise<Service> {
  if (!existing.stripeProductId) throw new StripeCatalogError("Prestation non liée à Stripe.");
  await assertSameMode(existing.stripeLivemode, "Cette prestation");
  try {
    const stripe = await getStripe();
    await stripe.products.update(existing.stripeProductId, {
      name: productName(input.name),
      description: input.description?.trim() || "",
    });
  } catch (e) {
    throw new StripeCatalogError(`Stripe n'a pas accepté la modification : ${e instanceof Error ? e.message : "erreur"}`);
  }
  let stripePriceId = existing.stripePriceId;
  if (input.unitPriceCents !== existing.unitPriceCents && existing.stripePriceId) {
    try {
      stripePriceId = await changeLinkedServicePrice(existing, input.unitPriceCents, requestId);
    } catch (err) {
      // Rien d'appliqué à moitié : le produit Stripe reprend son nom, l'ERP n'a pas changé.
      try {
        const stripe = await getStripe();
        await stripe.products.update(existing.stripeProductId, {
          name: productName(existing.name),
          description: existing.description?.trim() || "",
        });
      } catch {
        // Nom non rétabli : la synchro horaire (Stripe vers l'ERP) le reprendrait ; l'admin est prévenu.
        if (err instanceof StripeCatalogError) {
          throw new StripeCatalogError(
            `${err.message} Le nouveau nom est resté dans Stripe : remettez l'ancien dans Stripe ou réessayez la modification.`,
          );
        }
      }
      throw err;
    }
  }
  return prisma.service.update({
    where: { id: existing.id },
    data: {
      name: input.name,
      description: input.description,
      defaultBillingDay: existing.isSubscription ? input.defaultBillingDay : 1,
      unitPriceCents: input.unitPriceCents,
      stripePriceId,
      ...(input.category !== undefined ? { category: existing.isSubscription ? null : input.category } : {}),
    },
  });
}

/**
 * Supprime une prestation jamais utilisée ; si elle figure sur un document, un abonnement ou un pack, elle est
 * archivée (désactivée) pour ne pas altérer l'historique. Liée à Stripe : archivée aussi dans Stripe d'abord
 * (les abonnements Stripe en cours continuent).
 */
export async function removeService(id: string): Promise<{ archived: boolean } | null> {
  const service = await prisma.service.findUnique({
    where: { id },
    include: { _count: { select: { invoiceLines: true, subscriptions: true, inPacks: true } } },
  });
  if (!service) return null;
  if (service.stripeProductId) {
    await assertSameMode(service.stripeLivemode, "Cette prestation");
    await archiveLinkedService(service);
  }
  if (service._count.invoiceLines > 0 || service._count.subscriptions > 0 || service._count.inPacks > 0) {
    await prisma.service.update({ where: { id }, data: { active: false } });
    return { archived: true };
  }
  await prisma.service.delete({ where: { id } });
  return { archived: false };
}
