import { z } from "zod";
import type { Service } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { periodAmountCents } from "@/lib/quotes/billing-mode.js";
import type { BillingMode } from "@/lib/quotes/payment-plans.js";

/**
 * Packs : une prestation qui regroupe des prestations du catalogue avec leur quantité. Son prix (unitPriceCents)
 * est celui de la partie PONCTUELLE ; un abonnement inclus (ex. maintenance annuelle) reste une ligne d'abonnement
 * au prix plein, celui qui sera prélevé. Sur un devis, le pack se déplie en lignes détaillées groupées sous son
 * titre, plus une ligne « Remise pack » (prix du pack moins la somme de ses lignes ponctuelles).
 */

export const packItemsSchema = z
  .array(z.object({ serviceId: z.string().min(1), quantity: z.coerce.number().int().min(1).max(999) }))
  .min(1)
  .max(20);
export type PackItemInput = z.infer<typeof packItemsSchema>[number];

export class PackError extends Error {}

const oneOffSum = (items: Array<{ quantity: number; service: Pick<Service, "unitPriceCents" | "isSubscription"> }>) =>
  items.filter((i) => !i.service.isSubscription).reduce((s, i) => s + i.quantity * i.service.unitPriceCents, 0);

/** Contrôle la composition et le prix d'un pack ; renvoie les prestations dans l'ordre donné. */
export async function validatePack(items: PackItemInput[], priceCents: number, packId?: string) {
  if (new Set(items.map((i) => i.serviceId)).size !== items.length) {
    throw new PackError("Une prestation figure deux fois dans le pack : réglez plutôt sa quantité.");
  }
  const services = await prisma.service.findMany({ where: { id: { in: items.map((i) => i.serviceId) } } });
  const byId = new Map(services.map((s) => [s.id, s]));
  const resolved = items.map((i) => {
    const service = byId.get(i.serviceId);
    if (!service) throw new PackError("Prestation du pack introuvable.");
    if (service.isPack || service.id === packId) throw new PackError("Un pack ne peut pas contenir un autre pack.");
    if (!service.active) throw new PackError(`« ${service.name} » est archivée : elle ne peut pas entrer dans un pack.`);
    return { quantity: i.quantity, service };
  });
  // Depuis le mode de facturation (24/10/2026), le contenu d'un pack est descriptif : son prix d'achat et son prix
  // annuel sont libres, et il peut ne contenir que des abonnements.
  void priceCents;
  return resolved;
}

/** « Site vitrine, Rédaction (2), Maintenance » : contenu d'un pack, dans l'ordre de la fiche. */
export function packContents(items: Array<{ quantity: number; service: Pick<Service, "name"> }>): string {
  return items.map((i) => (i.quantity > 1 ? `${i.service.name} (${i.quantity})` : i.service.name)).join(", ");
}

/**
 * Pack sur un devis avec mode (24/10/2026) : UNE ligne « Nom : contenu ». Paiement unique : prix d'achat, contenu sans
 * les abonnements du pack, qui ne sont pas compris (28/10/2026). Récurrent : prix annuel ramené à la période, tout le
 * contenu ; refusé sans prix annuel. La description du pack n'est pas reprise : le devis imprime ce qui est compris.
 */
export async function packModeLine(packId: string, mode: BillingMode, interval: "MONTH" | "QUARTER" | "YEAR"): Promise<PackLine> {
  const pack = await prisma.service.findUnique({
    where: { id: packId },
    include: { packItems: { orderBy: { position: "asc" }, include: { service: true } } },
  });
  if (!pack || !pack.isPack) throw new PackError("Pack introuvable.");
  const items = mode === "ONE_OFF" ? pack.packItems.filter((i) => !i.service.isSubscription) : pack.packItems;
  const description = items.length ? `${pack.name} : ${packContents(items)}` : pack.name;
  const base = { serviceId: pack.id, description, quantity: 1, groupTitle: "", isPackDiscount: false };
  if (mode === "ONE_OFF") return { ...base, unitPriceCents: pack.unitPriceCents, isSubscription: false, billingInterval: null, billingDay: null };
  if (pack.annualPriceCents === null) {
    throw new PackError(`« ${pack.name} » n'a pas de prix annuel : renseignez-le dans le catalogue pour le vendre en abonnement.`);
  }
  return {
    ...base,
    unitPriceCents: periodAmountCents(pack.annualPriceCents, interval),
    isSubscription: true,
    billingInterval: interval,
    billingDay: pack.defaultBillingDay,
  };
}

export type PackLine = {
  serviceId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  isSubscription: boolean;
  billingInterval: "MONTH" | "QUARTER" | "YEAR" | null;
  billingDay: number | null;
  groupTitle: string;
  isPackDiscount: boolean;
};

/** Lignes de devis d'un pack : détail au prix catalogue, abonnements au prix plein, puis la remise du pack. */
export async function packLines(packId: string): Promise<PackLine[]> {
  const pack = await prisma.service.findUnique({
    where: { id: packId },
    include: { packItems: { orderBy: { position: "asc" }, include: { service: true } } },
  });
  if (!pack || !pack.isPack) throw new PackError("Pack introuvable.");
  const lines: PackLine[] = pack.packItems.map(({ quantity, service }) => ({
    serviceId: service.id,
    description: service.description ? `${service.name} : ${service.description}` : service.name,
    quantity: service.isSubscription ? 1 : quantity,
    unitPriceCents: service.unitPriceCents,
    isSubscription: service.isSubscription,
    billingInterval: service.isSubscription ? (service.billingInterval === "YEAR" ? "YEAR" : "MONTH") : null,
    billingDay: service.isSubscription ? service.defaultBillingDay : null,
    groupTitle: pack.name,
    isPackDiscount: false,
  }));
  const discount = pack.unitPriceCents - oneOffSum(pack.packItems);
  if (discount < 0) {
    lines.push({
      serviceId: pack.id,
      description: `Remise ${pack.name}`,
      quantity: 1,
      unitPriceCents: discount,
      isSubscription: false,
      billingInterval: null,
      billingDay: null,
      groupTitle: pack.name,
      isPackDiscount: true,
    });
  }
  return lines;
}
