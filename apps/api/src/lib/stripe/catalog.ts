import { ServiceUnit } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { getStripe } from "@/lib/stripe/client.js";
import { alertAdmin } from "@/lib/stripe/alert.js";
import { keyLivemode, modeLabel } from "@/lib/stripe/mode.js";
import { clientServiceName } from "@/lib/services/annual-price.js";

/**
 * Filet : une synchro qui archiverait d'un coup plus de 3 prestations, ou plus de 20 % des
 * prestations liées (à partir de 2 : une seule archivée reste permise sur un petit catalogue),
 * est refusée (clé d'un autre compte, catalogue vidé par erreur…).
 */
export const MAX_ARCHIVE_COUNT = 3;
export const MAX_ARCHIVE_SHARE = 0.2;
// Une alerte au plus toutes les 24 h par processus (la synchro tourne chaque heure).
let lastBlockedAlertAt = 0;

export type CatalogSyncAction = {
  name: string;
  action: "create" | "update" | "archive" | "same" | "blocked";
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
  const live = await keyLivemode();
  const actions: CatalogSyncAction[] = [];
  const seenPriceIds = new Set<string>();

  // Toutes les pages : au-delà de 100 prix, une prestation non lue serait archivée à tort.
  const prices: Stripe.Price[] = [];
  for await (const price of stripe.prices.list({ active: true, expand: ["data.product"], limit: 100 })) prices.push(price);

  // Produit + périodicité ayant un prix actif créé depuis l'ERP (changement de prix en cours) :
  // un prix actif PLUS ANCIEN de ce couple, non relié, est l'ancien prix, pas une nouvelle
  // prestation. Un prix plus récent (créé ensuite dans le tableau de bord Stripe) est importé.
  const replacementCreatedAt = new Map<string, number>();
  for (const p of prices) {
    if (!p.metadata?.erpServiceId) continue;
    const key = `${typeof p.product === "string" ? p.product : p.product.id}:${intervalFromPrice(p)}`;
    replacementCreatedAt.set(key, Math.max(replacementCreatedAt.get(key) ?? 0, p.created));
  }

  for (const price of prices) {
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
      stripeLivemode: price.livemode,
    };

    // Rapprochement : prix Stripe, puis prestation ERP désignée par le prix (nouveau prix créé
    // depuis l'ERP), puis nom pour une prestation ERP pas encore liée.
    const erpServiceId = price.metadata?.erpServiceId;
    const existing =
      (await prisma.service.findFirst({ where: { stripePriceId: price.id } })) ??
      (erpServiceId ? await prisma.service.findUnique({ where: { id: erpServiceId } }) : null) ??
      (await prisma.service.findFirst({ where: { name, stripePriceId: null } }));

    // Ancien prix encore actif pendant un changement de prix : le produit est déjà relié avec la
    // même périodicité et ce prix n'est plus celui par défaut. Pas de seconde prestation.
    const defaultPriceId = typeof product.default_price === "string" ? product.default_price : product.default_price?.id;
    const replacedAt = replacementCreatedAt.get(`${product.id}:${billingInterval}`);
    if (!existing && !price.metadata?.erpServiceId && replacedAt !== undefined && price.created <= replacedAt) {
      actions.push({ name, action: "same", stripePriceId: price.id });
      continue;
    }
    if (!existing && defaultPriceId && defaultPriceId !== price.id) {
      const sibling = await prisma.service.findFirst({
        where: { stripeProductId: product.id, billingInterval, stripePriceId: { not: null } },
      });
      if (sibling) {
        actions.push({ name, action: "same", stripePriceId: price.id });
        continue;
      }
    }

    if (!existing) {
      try {
        await prisma.service.create({ data: { ...data, defaultBillingDay: 1 } });
        actions.push({ name, action: "create", stripePriceId: price.id });
      } catch (err) {
        // Prestation créée depuis l'ERP au même instant (même prix Stripe) : rien à ajouter.
        if ((err as { code?: string }).code !== "P2002") throw err;
        actions.push({ name, action: "same", stripePriceId: price.id });
      }
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
      existing.stripeLivemode !== data.stripeLivemode ||
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

  // Prestations liées à Stripe mais plus présentes : archive. Seulement celles du mode de la
  // clé : avec une clé test, les prestations live sont introuvables mais toujours valables.
  const linked = await prisma.service.count({
    where: { active: true, stripePriceId: { not: null }, stripeLivemode: live },
  });
  const orphaned = await prisma.service.findMany({
    where: {
      active: true,
      stripePriceId: { not: null },
      stripeLivemode: live,
      NOT: { stripePriceId: { in: [...seenPriceIds] } },
    },
  });
  if (orphaned.length > MAX_ARCHIVE_COUNT || (orphaned.length >= 2 && orphaned.length > linked * MAX_ARCHIVE_SHARE)) {
    for (const s of orphaned) actions.push({ name: s.name, action: "blocked", stripePriceId: s.stripePriceId });
    if (Date.now() - lastBlockedAlertAt > 24 * 3_600_000) {
      lastBlockedAlertAt = Date.now();
      await alertAdmin(
        "Synchro Stripe bloquée : archivage massif refusé",
        `La synchro du catalogue Stripe (clé ${modeLabel(live)}) aurait archivé ${orphaned.length} prestation(s) sur ${linked} : ${orphaned
          .map((s) => s.name)
          .join(", ")}. Rien n'a été archivé. Vérifiez la clé Stripe (compte, mode test ou live) dans Réglages > Paiements, ou archivez ces prestations une à une.`,
      );
    }
    return actions;
  }
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
        name: clientServiceName(service.name),
        description: service.description ?? undefined,
        metadata: { erpServiceId: service.id },
      });
      productId = product.id;
    } else {
      await stripe.products.update(productId, {
        name: clientServiceName(service.name),
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
