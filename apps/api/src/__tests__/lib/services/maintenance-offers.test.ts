import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import {
  ensureMaintenanceOffers,
  MAINTENANCE_PACK_ID,
  MAINTENANCE_SITE_ID,
  MAINTENANCE_UPGRADE_MARKER,
} from "@/lib/services/maintenance-offers.js";
import { packModeLines } from "@/lib/services/packs.js";
import { resetDb } from "../../helpers/db.js";

beforeEach(async () => {
  await resetDb();
});

async function seedPack() {
  const old = await prisma.service.create({
    data: { name: "Maintenance Site (annuel)", unitPriceCents: 65000, isSubscription: true, billingInterval: "YEAR" },
  });
  const site = await prisma.service.create({ data: { name: "Site vitrine (5 pages)", unitPriceCents: 130000, category: "SITE" } });
  const pack = await prisma.service.create({
    data: {
      name: "Pack Vitrine",
      unitPriceCents: 140000,
      isPack: true,
      packItems: {
        create: [
          { serviceId: site.id, quantity: 1, position: 0 },
          { serviceId: old.id, quantity: 1, position: 1 },
        ],
      },
    },
  });
  return { old, site, pack };
}

describe("offres de maintenance du site (mise à niveau au démarrage)", () => {
  it("crée les deux maintenances annuelles, clés stables, sans doublon au second passage", async () => {
    const log = await ensureMaintenanceOffers();
    expect(log.length).toBeGreaterThan(0);
    const pack = await prisma.service.findUniqueOrThrow({ where: { id: MAINTENANCE_PACK_ID } });
    const site = await prisma.service.findUniqueOrThrow({ where: { id: MAINTENANCE_SITE_ID } });
    for (const s of [pack, site]) {
      expect(s).toMatchObject({ isSubscription: true, billingInterval: "YEAR", category: "SITE", active: true, isPack: false });
      expect(s.description).toContain("renouvellement du nom de domaine");
      expect([...(s.description ?? "")].some((c) => [0x2013, 0x2014].includes(c.codePointAt(0)!))).toBe(false);
    }
    expect(pack).toMatchObject({ name: "Maintenance site (pack)", unitPriceCents: 19700 });
    expect(site).toMatchObject({ name: "Maintenance site", unitPriceCents: 35000 });

    expect(await ensureMaintenanceOffers()).toEqual([]);
    expect(await prisma.service.count()).toBe(2);
  });

  it("une maintenance modifiée par Alexandre n'est jamais écrasée, même sans la marque de passage", async () => {
    await ensureMaintenanceOffers();
    await prisma.service.update({ where: { id: MAINTENANCE_SITE_ID }, data: { unitPriceCents: 39000, name: "Maintenance" } });
    await prisma.namedCounter.delete({ where: { name: MAINTENANCE_UPGRADE_MARKER } });
    await ensureMaintenanceOffers();
    expect(await prisma.service.findUniqueOrThrow({ where: { id: MAINTENANCE_SITE_ID } })).toMatchObject({
      unitPriceCents: 39000,
      name: "Maintenance",
    });
    expect(await prisma.service.count()).toBe(2);
  });

  it("remplace l'ancienne maintenance des packs par la maintenance pack et archive l'ancienne", async () => {
    const { old, site, pack } = await seedPack();
    const log = await ensureMaintenanceOffers();
    const items = await prisma.servicePackItem.findMany({ where: { packId: pack.id }, orderBy: { position: "asc" } });
    expect(items.map((i) => [i.serviceId, i.position])).toEqual([
      [site.id, 0],
      [MAINTENANCE_PACK_ID, 1],
    ]);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: old.id } })).active).toBe(false);
    expect(log.join("\n")).toContain("Pack Vitrine");

    // Relancé : rien ne change (ancienne maintenance remise à la main dans un pack : laissée).
    await prisma.service.update({ where: { id: old.id }, data: { active: true } });
    expect(await ensureMaintenanceOffers()).toEqual([]);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: old.id } })).active).toBe(true);
  });

  it("ancienne maintenance liée à Stripe : remplacée dans les packs mais laissée active (archivage par Prestations)", async () => {
    const { old, pack } = await seedPack();
    await prisma.service.update({ where: { id: old.id }, data: { stripeProductId: "prod_x", stripePriceId: "price_x" } });
    const log = await ensureMaintenanceOffers();
    expect((await prisma.service.findUniqueOrThrow({ where: { id: old.id } })).active).toBe(true);
    expect(log.join("\n")).toContain("Stripe");
    expect(await prisma.servicePackItem.count({ where: { packId: pack.id, serviceId: MAINTENANCE_PACK_ID } })).toBe(1);
  });

  it("paiement unique : le pack propose Maintenance site à 350 € en option ; récurrent : il comprend la maintenance pack", async () => {
    const { pack } = await seedPack();
    await ensureMaintenanceOffers();
    const oneOff = await packModeLines(pack.id, "ONE_OFF", "YEAR");
    const options = oneOff.filter((l) => l.isOptional);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ serviceId: MAINTENANCE_SITE_ID, unitPriceCents: 35000, billingInterval: "YEAR", commitmentMonths: 12 });
    expect(oneOff[0]!.description).not.toContain("Maintenance");

    await prisma.service.update({ where: { id: pack.id }, data: { annualPriceCents: 60000 } });
    const recurring = await packModeLines(pack.id, "RECURRING", "YEAR");
    expect(recurring).toHaveLength(1);
    expect(recurring[0]!.description).toContain("Maintenance site (pack)");
  });

  it("maintenance autonome archivée : le pack en paiement unique repropose sa propre maintenance", async () => {
    const { pack } = await seedPack();
    await ensureMaintenanceOffers();
    await prisma.service.update({ where: { id: MAINTENANCE_SITE_ID }, data: { active: false } });
    const options = (await packModeLines(pack.id, "ONE_OFF", "YEAR")).filter((l) => l.isOptional);
    expect(options[0]).toMatchObject({ serviceId: MAINTENANCE_PACK_ID, unitPriceCents: 19700 });
  });
});
