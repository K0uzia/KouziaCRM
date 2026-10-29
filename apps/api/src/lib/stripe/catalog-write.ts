import { Prisma, ServiceUnit, type Service } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getStripe } from "@/lib/stripe/client.js";
import { keyLivemode } from "@/lib/stripe/mode.js";

/** Stripe a refusé l'écriture : rien n'a changé dans l'ERP. */
export class StripeCatalogError extends Error {
  statusCode = 502;
}

export type Interval = "MONTH" | "YEAR";

/** Nom de la prestation ERP, identique à celui que donne la synchro (« (annuel) » pour un prix annuel). */
export function erpServiceName(base: string, interval: Interval | null): string {
  return interval === "YEAR" ? `${base.trim()} (annuel)` : base.trim();
}

function productName(serviceName: string): string {
  return serviceName.replace(/\s*\(annuel\)\s*$/i, "").trim();
}

function fail(what: string, err: unknown): never {
  const detail = err instanceof Error && err.message ? ` Détail Stripe : ${err.message.replace(/\.$/, "")}.` : "";
  throw new StripeCatalogError(`${what}${detail}`);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export type CreateLinkedServiceInput = {
  name: string;
  description: string | null;
  unitPriceCents: number;
  isSubscription: boolean;
  billingInterval: Interval | null;
  defaultBillingDay: number;
  /** Une clé par ouverture du formulaire : un double envoi ne crée pas deux produits. */
  requestId: string;
};

type StripeOffer = {
  /** Nom ERP (« (annuel) » compris pour un prix annuel) ; le produit Stripe le prend sans ce suffixe. */
  name: string;
  description: string | null;
  unitPriceCents: number;
  interval: Interval | null;
  requestId: string;
};

/**
 * Produit puis prix dans Stripe, comme à la création depuis l'écran Prestations : un seul chemin pour une prestation
 * créée (createLinkedService) et pour une prestation déjà dans l'ERP qu'on relie (linkExistingService).
 */
async function createStripeProductAndPrice(offer: StripeOffer): Promise<{ productId: string; priceId: string }> {
  try {
    const stripe = await getStripe();
    const product = await stripe.products.create(
      {
        name: productName(offer.name),
        ...(offer.description ? { description: offer.description } : {}),
        metadata: { source: "kouzia-erp" },
      },
      { idempotencyKey: `kouzia-service-product-${offer.requestId}` },
    );
    const price = await stripe.prices.create(
      {
        product: product.id,
        currency: "eur",
        unit_amount: offer.unitPriceCents,
        ...(offer.interval ? { recurring: { interval: offer.interval === "YEAR" ? "year" : "month" } } : {}),
      },
      { idempotencyKey: `kouzia-service-price-${offer.requestId}` },
    );
    return { productId: product.id, priceId: price.id };
  } catch (err) {
    fail("Stripe n'a pas créé la prestation : rien n'a été enregistré.", err);
  }
}

/**
 * Prestation créée dans l'ERP avec Stripe actif : produit puis prix dans Stripe, puis la
 * prestation liée. Si Stripe échoue, rien n'est créé. Le webhook product/price.created peut
 * arriver avant la fin : la prestation qu'il aurait créée (même prix Stripe) est reprise.
 */
export async function createLinkedService(input: CreateLinkedServiceInput): Promise<Service> {
  const interval = input.isSubscription ? (input.billingInterval ?? "MONTH") : null;
  const name = erpServiceName(input.name, interval);
  const livemode = await keyLivemode();
  const { productId, priceId } = await createStripeProductAndPrice({
    name,
    description: input.description,
    unitPriceCents: input.unitPriceCents,
    interval,
    requestId: input.requestId,
  });

  const data = {
    name,
    description: input.description,
    unitPriceCents: input.unitPriceCents,
    unit: ServiceUnit.FORFAIT,
    active: true,
    isSubscription: input.isSubscription,
    billingInterval: interval,
    defaultBillingDay: input.isSubscription ? input.defaultBillingDay : 1,
    stripeProductId: productId,
    stripePriceId: priceId,
    stripeLivemode: livemode,
  };
  const existing = await prisma.service.findUnique({ where: { stripePriceId: priceId } });
  if (existing) return prisma.service.update({ where: { id: existing.id }, data });
  try {
    return await prisma.service.create({ data });
  } catch (err) {
    // La synchro du webhook a créé la même prestation entre-temps : on la complète.
    if (!isUniqueViolation(err)) throw err;
    return prisma.service.update({ where: { stripePriceId: priceId }, data });
  }
}

/**
 * Prestation déjà dans l'ERP, pas encore liée (ex. maintenances créées au démarrage avec un identifiant fixe) :
 * même produit, même prix et même nom que si elle avait été créée depuis Prestations avec Stripe actif. Son
 * identifiant ne change pas (packs, devis et contrats qui la citent restent liés). Si Stripe échoue, rien ne change.
 * Le webhook peut avoir créé entre-temps une prestation pour ce prix : ce doublon tout neuf est retiré.
 */
export async function linkExistingService(service: Service, requestId: string): Promise<Service> {
  if (service.stripeProductId) return service;
  if (service.isPack) throw new StripeCatalogError("Un pack n'est jamais lié à Stripe.");
  const interval: Interval | null = service.isSubscription ? (service.billingInterval === "YEAR" ? "YEAR" : "MONTH") : null;
  const name = erpServiceName(productName(service.name), interval);
  const livemode = await keyLivemode();
  const { productId, priceId } = await createStripeProductAndPrice({
    name,
    description: service.description?.trim() || null,
    unitPriceCents: service.unitPriceCents,
    interval,
    requestId,
  });
  return prisma.$transaction(async (tx) => {
    const dup = await tx.service.findUnique({
      where: { stripePriceId: priceId },
      include: { _count: { select: { invoiceLines: true, subscriptions: true, inPacks: true, clientNeeds: true, packItems: true } } },
    });
    if (dup && dup.id !== service.id) {
      const used = Object.values(dup._count).some((n) => n > 0);
      if (used) throw new StripeCatalogError(`Le prix Stripe ${priceId} porte déjà la prestation « ${dup.name} ».`);
      await tx.service.delete({ where: { id: dup.id } });
    }
    return tx.service.update({
      where: { id: service.id },
      data: { name, billingInterval: interval, stripeProductId: productId, stripePriceId: priceId, stripeLivemode: livemode },
    });
  });
}

/**
 * Nouveau prix d'une prestation liée : Stripe interdit de modifier un prix, on en crée un
 * nouveau (même périodicité), il devient le prix par défaut du produit et l'ancien est archivé.
 * Les abonnements Stripe en cours gardent l'ancien prix.
 */
export async function changeLinkedServicePrice(
  service: Service,
  unitPriceCents: number,
  requestId: string,
): Promise<string> {
  if (!service.stripeProductId || !service.stripePriceId) {
    throw new StripeCatalogError("Prestation non liée à Stripe.");
  }
  try {
    const stripe = await getStripe();
    const interval = service.isSubscription ? (service.billingInterval === "YEAR" ? "year" : "month") : null;
    const price = await stripe.prices.create(
      {
        product: service.stripeProductId,
        currency: "eur",
        unit_amount: unitPriceCents,
        ...(interval ? { recurring: { interval } } : {}),
        // Rapprochement par la synchro tant que l'ancien prix est encore actif.
        metadata: { erpServiceId: service.id },
      },
      { idempotencyKey: `kouzia-service-reprice-${requestId}` },
    );
    await stripe.products.update(service.stripeProductId, { default_price: price.id });
    await stripe.prices.update(service.stripePriceId, { active: false });
    return price.id;
  } catch (err) {
    fail("Stripe n'a pas changé le prix : la prestation garde son prix actuel.", err);
  }
}

/**
 * Archivage depuis l'ERP : produit archivé dans Stripe s'il ne porte pas d'autre prestation
 * active ; sinon (prix mensuel et prix annuel sur le même produit), seul ce prix est archivé.
 */
export async function archiveLinkedService(service: Service): Promise<void> {
  if (!service.stripeProductId) return;
  try {
    const stripe = await getStripe();
    const other = await prisma.service.findFirst({
      where: { stripeProductId: service.stripeProductId, active: true, NOT: { id: service.id } },
      select: { stripePriceId: true },
    });
    if (!other) {
      // Seule prestation du produit : le produit archivé suffit (la synchro ignore ses prix).
      await stripe.products.update(service.stripeProductId, { active: false });
    } else if (service.stripePriceId) {
      // Stripe refuse d'archiver le prix par défaut d'un produit : il passe d'abord à l'autre prix.
      const product = await stripe.products.retrieve(service.stripeProductId);
      const defaultId = typeof product.default_price === "string" ? product.default_price : product.default_price?.id;
      if (defaultId === service.stripePriceId && other.stripePriceId) {
        await stripe.products.update(service.stripeProductId, { default_price: other.stripePriceId });
      }
      await stripe.prices.update(service.stripePriceId, { active: false });
    }
  } catch (err) {
    fail("Stripe n'a pas archivé la prestation : elle reste active.", err);
  }
}
