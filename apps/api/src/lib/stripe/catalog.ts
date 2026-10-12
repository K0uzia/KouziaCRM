import { ServiceUnit } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { getStripe } from "@/lib/stripe/client.js";

export type CatalogSyncAction = {
  name: string;
  action: "create" | "update" | "archive" | "same";
  stripePriceId: string | null;
};

function intervalFromPrice(price: Stripe.Price): string | null {
  if (price.type !== "recurring" || !price.recurring) return null;
  if (price.recurring.interval === "year") return "YEAR";
  if (price.recurring.interval === "month") return "MONTH";
  return null;
}

function serviceName(product: Stripe.Product, price: Stripe.Price): string {
  const base = product.name.trim();
  const interval = intervalFromPrice(price);
  if (interval === "YEAR") return `${base} (annuel)`;
  if (interval === "MONTH" && !/mensuel/i.test(base)) return base;
  return base;
}

/** Recopie les Products/Prices Stripe actifs vers les prestations ERP. */
export async function syncCatalogFromStripe(): Promise<CatalogSyncAction[]> {
  const stripe = await getStripe();
  const actions: CatalogSyncAction[] = [];
  const seenPriceIds = new Set<string>();

  // Toutes les pages : au-delà de 100 prix, une prestation non lue serait archivée à tort.
  for await (const price of stripe.prices.list({ active: true, expand: ["data.product"], limit: 100 })) {
    const product = price.product;
    if (typeof product === "string" || product.deleted) continue;
    if (!product.active) continue;
    if (price.currency !== "eur") continue;
    if (price.unit_amount == null) continue;

    seenPriceIds.add(price.id);
    const billingInterval = intervalFromPrice(price);
    const isSubscription = billingInterval !== null;
    const name = serviceName(product, price);
    const description = product.description?.trim() || null;
    const data = {
      name,
      description,
      unitPriceCents: price.unit_amount,
      unit: ServiceUnit.FORFAIT,
      active: true,
      isSubscription,
      stripeProductId: product.id,
      stripePriceId: price.id,
      billingInterval,
    };

    // Rapprochement par prix Stripe ; par nom seulement pour une prestation ERP pas encore liée.
    const existing =
      (await prisma.service.findFirst({ where: { stripePriceId: price.id } })) ??
      (await prisma.service.findFirst({ where: { name, stripePriceId: null } }));

    if (!existing) {
      await prisma.service.create({ data: { ...data, defaultBillingDay: 1 } });
      actions.push({ name, action: "create", stripePriceId: price.id });
      continue;
    }

    const changed =
      existing.name !== data.name ||
      existing.unitPriceCents !== data.unitPriceCents ||
      (existing.description ?? "") !== (data.description ?? "") ||
      existing.isSubscription !== data.isSubscription ||
      existing.stripePriceId !== data.stripePriceId ||
      existing.stripeProductId !== data.stripeProductId ||
      existing.billingInterval !== data.billingInterval ||
      !existing.active;

    if (changed) {
      await prisma.service.update({
        where: { id: existing.id },
        data,
      });
      actions.push({ name, action: "update", stripePriceId: price.id });
    } else {
      actions.push({ name, action: "same", stripePriceId: price.id });
    }
  }

  // Prestations liées à Stripe mais plus présentes : archive.
  const orphaned = await prisma.service.findMany({
    where: {
      active: true,
      stripePriceId: { not: null },
      NOT: { stripePriceId: { in: [...seenPriceIds] } },
    },
  });
  for (const s of orphaned) {
    await prisma.service.update({
      where: { id: s.id },
      data: { active: false },
    });
    actions.push({ name: s.name, action: "archive", stripePriceId: s.stripePriceId });
  }

  return actions;
}

export type PushCatalogResult = {
  name: string;
  action: "created" | "updated" | "skipped";
  stripeProductId: string;
  stripePriceId: string;
};

/**
 * Envoie le catalogue ERP (prestations actives) vers Stripe.
 * Un prix Stripe ne se modifie pas : si le montant change, on archive l'ancien et on crée un nouveau.
 */
export async function pushCatalogToStripe(): Promise<PushCatalogResult[]> {
  const stripe = await getStripe();
  const services = await prisma.service.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
  });
  const results: PushCatalogResult[] = [];

  for (const service of services) {
    let productId = service.stripeProductId;
    if (!productId) {
      const product = await stripe.products.create({
        name: service.name.replace(/\s*\(annuel\)\s*$/i, "").trim(),
        description: service.description ?? undefined,
        metadata: { erpServiceId: service.id },
      });
      productId = product.id;
    } else {
      await stripe.products.update(productId, {
        name: service.name.replace(/\s*\(annuel\)\s*$/i, "").trim(),
        description: service.description ?? undefined,
        active: true,
      });
    }

    let priceId = service.stripePriceId;
    let action: PushCatalogResult["action"] = "skipped";

    if (priceId) {
      const existing = await stripe.prices.retrieve(priceId);
      const sameAmount = existing.unit_amount === service.unitPriceCents;
      const wantRecurring = service.isSubscription;
      const isRecurring = existing.type === "recurring";
      const sameInterval =
        !wantRecurring ||
        (existing.recurring?.interval === "month" &&
          (service.billingInterval === "MONTH" || !service.billingInterval)) ||
        (existing.recurring?.interval === "year" && service.billingInterval === "YEAR");

      if (sameAmount && wantRecurring === isRecurring && sameInterval && existing.active) {
        await prisma.service.update({
          where: { id: service.id },
          data: { stripeProductId: productId, stripePriceId: priceId },
        });
        results.push({
          name: service.name,
          action: "skipped",
          stripeProductId: productId,
          stripePriceId: priceId,
        });
        continue;
      }
      await stripe.prices.update(priceId, { active: false });
      priceId = null;
    }

    const recurring =
      service.isSubscription
        ? {
            interval: (service.billingInterval === "YEAR" ? "year" : "month") as
              | "year"
              | "month",
          }
        : undefined;

    const price = await stripe.prices.create({
      product: productId,
      currency: "eur",
      unit_amount: service.unitPriceCents,
      ...(recurring ? { recurring } : {}),
      metadata: { erpServiceId: service.id },
    });
    priceId = price.id;
    action = service.stripePriceId ? "updated" : "created";

    await prisma.service.update({
      where: { id: service.id },
      data: {
        stripeProductId: productId,
        stripePriceId: priceId,
        billingInterval: service.isSubscription
          ? service.billingInterval === "YEAR"
            ? "YEAR"
            : "MONTH"
          : null,
      },
    });

    results.push({
      name: service.name,
      action,
      stripeProductId: productId,
      stripePriceId: priceId,
    });
  }

  return results;
}
