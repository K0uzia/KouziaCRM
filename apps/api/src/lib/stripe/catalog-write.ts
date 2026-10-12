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

/**
 * Prestation créée dans l'ERP avec Stripe actif : produit puis prix dans Stripe, puis la
 * prestation liée. Si Stripe échoue, rien n'est créé. Le webhook product/price.created peut
 * arriver avant la fin : la prestation qu'il aurait créée (même prix Stripe) est reprise.
 */
export async function createLinkedService(input: CreateLinkedServiceInput): Promise<Service> {
  const interval = input.isSubscription ? (input.billingInterval ?? "MONTH") : null;
  const name = erpServiceName(input.name, interval);
  const livemode = await keyLivemode();
  let productId: string;
  let priceId: string;
  try {
    const stripe = await getStripe();
    const product = await stripe.products.create(
      {
        name: productName(name),
        ...(input.description ? { description: input.description } : {}),
        metadata: { source: "kouzia-erp" },
      },
      { idempotencyKey: `kouzia-service-product-${input.requestId}` },
    );
    const price = await stripe.prices.create(
      {
        product: product.id,
        currency: "eur",
        unit_amount: input.unitPriceCents,
        ...(interval ? { recurring: { interval: interval === "YEAR" ? "year" : "month" } } : {}),
      },
      { idempotencyKey: `kouzia-service-price-${input.requestId}` },
    );
    productId = product.id;
    priceId = price.id;
  } catch (err) {
    fail("Stripe n'a pas créé la prestation : rien n'a été enregistré.", err);
  }

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
