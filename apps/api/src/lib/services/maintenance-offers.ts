import { ServiceUnit, type PrismaClient, type Service } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

/**
 * Maintenance du site (décision du 28/10/2026) : deux abonnements annuels au même contenu.
 * « Maintenance site (pack) » (197 €) est compris dans les packs vendus en abonnement ; « Maintenance site » (350 €)
 * se vend seule, ou en option d'un site (ou d'un pack) en paiement unique. Clé stable = identifiant fixe de la
 * prestation (Service n'a pas de champ clé ; un identifiant choisi évite une migration).
 */
export const MAINTENANCE_PACK_ID = "kouzia-maintenance-site-pack";
export const MAINTENANCE_SITE_ID = "kouzia-maintenance-site";
/** Compteur nommé posé une fois la mise à niveau faite : elle ne repasse jamais (même si une offre est retouchée). */
export const MAINTENANCE_UPGRADE_MARKER = "upgrade:maintenance-offres-2026-10";

export const MAINTENANCE_DESCRIPTION =
  "Hébergement du site, renouvellement du nom de domaine, HTTPS, surveillance 24 h/24 par le hub, sauvegardes quotidiennes, mises à jour de sécurité et corrections. Retouches et évolutions sur devis séparé.";

export const MAINTENANCE_OFFERS = [
  { id: MAINTENANCE_PACK_ID, name: "Maintenance site (pack)", priceCents: 19700 },
  { id: MAINTENANCE_SITE_ID, name: "Maintenance site", priceCents: 35000 },
] as const;

/** Abonnement compris dans un pack -> abonnement proposé en option en paiement unique. */
const ONE_OFF_EQUIVALENT: Readonly<Record<string, string>> = { [MAINTENANCE_PACK_ID]: MAINTENANCE_SITE_ID };

/** Paiement unique : chaque abonnement remplacé par son équivalent vendu seul (s'il existe et est actif). */
export async function oneOffEquivalents<T extends Pick<Service, "id">>(services: T[]): Promise<Array<T | Service>> {
  const ids = [...new Set(services.map((s) => ONE_OFF_EQUIVALENT[s.id]).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return services;
  const found = new Map((await prisma.service.findMany({ where: { id: { in: ids }, active: true } })).map((s) => [s.id, s]));
  return services.map((s) => found.get(ONE_OFF_EQUIVALENT[s.id] ?? "") ?? s);
}

/** Ancienne maintenance du site (avant le 28/10/2026), reconnue par son nom, casse ignorée. */
const LEGACY_NAMES = new Set(["maintenance site", "maintenance site (annuel)"]);
const isLegacy = (s: Pick<Service, "id" | "name" | "isSubscription" | "isPack">) =>
  s.isSubscription && !s.isPack && !ONE_OFF_EQUIVALENT[s.id] && s.id !== MAINTENANCE_SITE_ID &&
  LEGACY_NAMES.has(s.name.trim().replace(/\s+/g, " ").toLowerCase());

/**
 * Mise à niveau au démarrage, une seule fois : crée les deux maintenances absentes (jamais réécrites), remplace dans
 * les packs l'ancienne maintenance du site par la maintenance pack, archive l'ancienne (sauf liée à Stripe : son
 * archivage passe par Prestations, qui archive aussi le produit Stripe). Devis, factures et abonnements : inchangés.
 * Renvoie le journal de ce qui a changé (vide si déjà faite).
 */
export async function ensureMaintenanceOffers(db: PrismaClient = prisma): Promise<string[]> {
  if (await db.namedCounter.findUnique({ where: { name: MAINTENANCE_UPGRADE_MARKER } })) return [];
  return db.$transaction(async (tx) => {
    const log: string[] = [];
    for (const offer of MAINTENANCE_OFFERS) {
      if (await tx.service.findUnique({ where: { id: offer.id } })) continue;
      await tx.service.create({
        data: {
          id: offer.id,
          name: offer.name,
          description: MAINTENANCE_DESCRIPTION,
          unitPriceCents: offer.priceCents,
          unit: ServiceUnit.FORFAIT,
          isSubscription: true,
          billingInterval: "YEAR",
          defaultBillingDay: 1,
          category: "SITE",
        },
      });
      log.push(`prestation créée : « ${offer.name} », ${offer.priceCents / 100} € par an`);
    }

    const legacy = (await tx.service.findMany({ where: { isSubscription: true, isPack: false } })).filter(isLegacy);
    for (const old of legacy) {
      const items = await tx.servicePackItem.findMany({ where: { serviceId: old.id }, include: { pack: { select: { name: true } } } });
      for (const item of items) {
        const already = await tx.servicePackItem.findUnique({ where: { packId_serviceId: { packId: item.packId, serviceId: MAINTENANCE_PACK_ID } } });
        if (already) await tx.servicePackItem.delete({ where: { id: item.id } });
        else await tx.servicePackItem.update({ where: { id: item.id }, data: { serviceId: MAINTENANCE_PACK_ID } });
        log.push(`${item.pack.name} : « ${old.name} » remplacée par « Maintenance site (pack) »`);
      }
      if (!old.active) continue;
      if (old.stripeProductId) {
        log.push(`« ${old.name} » liée à Stripe, laissée active : l'archiver dans Prestations (archive aussi le produit Stripe)`);
      } else {
        await tx.service.update({ where: { id: old.id }, data: { active: false } });
        log.push(`« ${old.name} » archivée (devis, factures et abonnements qui la citent inchangés)`);
      }
    }
    await tx.namedCounter.create({ data: { name: MAINTENANCE_UPGRADE_MARKER, lastValue: 1 } });
    return log;
  });
}
