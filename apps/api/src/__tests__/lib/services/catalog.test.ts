import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { applyCatalog, CATALOG, CATALOG_PACKS } from "@/lib/services/catalog.js";
import { MAINTENANCE_PACK_ID } from "@/lib/services/maintenance-offers.js";
import { resetDb } from "../../helpers/db.js";

beforeEach(async () => {
  await resetDb();
});

describe("import du catalogue", () => {
  it("simulation : rien n'est écrit", async () => {
    const actions = await applyCatalog(prisma, { dryRun: true });
    expect(actions.filter((a) => a.action === "create")).toHaveLength(CATALOG.length + CATALOG_PACKS.length);
    expect(await prisma.service.count()).toBe(0);
  });

  it("relancé, il ne crée aucun doublon", async () => {
    await applyCatalog(prisma);
    const again = await applyCatalog(prisma);
    expect(again.every((a) => a.action === "same")).toBe(true);
    expect(await prisma.service.count()).toBe(CATALOG.length + CATALOG_PACKS.length);
  });

  it("un prix modifié dans l'ERP n'est écrasé qu'avec --update", async () => {
    await applyCatalog(prisma);
    const name = CATALOG[0]!.name;
    await prisma.service.updateMany({ where: { name }, data: { unitPriceCents: 1 } });

    const sans = await applyCatalog(prisma);
    expect(sans.find((a) => a.name === name)?.action).toBe("differs");
    expect((await prisma.service.findFirstOrThrow({ where: { name } })).unitPriceCents).toBe(1);

    const avec = await applyCatalog(prisma, { update: true });
    expect(avec.find((a) => a.name === name)?.action).toBe("update");
    expect((await prisma.service.findFirstOrThrow({ where: { name } })).unitPriceCents).toBe(CATALOG[0]!.priceCents);
  });

  it("prestation liée à Stripe : jamais écrite, même avec --update ; listée dans la simulation", async () => {
    await applyCatalog(prisma);
    const entry = CATALOG[0]!;
    const linked = await prisma.service.update({
      where: { id: (await prisma.service.findFirstOrThrow({ where: { name: entry.name } })).id },
      data: { unitPriceCents: 1, stripeProductId: "prod_x", stripePriceId: "price_x" },
    });
    const legacy = await prisma.service.create({ data: { name: "Maintenance site web", unitPriceCents: 2, unit: "FORFAIT", active: true, stripeProductId: "prod_y" } });
    const simulation = await applyCatalog(prisma, { dryRun: true, update: true });
    expect(simulation.filter((a) => a.action === "stripe").map((a) => a.name).sort()).toEqual([entry.name, "Maintenance site web"].sort());
    await applyCatalog(prisma, { update: true });
    expect(await prisma.service.findUniqueOrThrow({ where: { id: linked.id } })).toMatchObject({ unitPriceCents: 1, stripePriceId: "price_x" });
    expect((await prisma.service.findUniqueOrThrow({ where: { id: legacy.id } })).active).toBe(true);
  });

  it("grille : rubriques, abonnements annuels, packs au plus le détail et remise positive", async () => {
    await applyCatalog(prisma);
    const all = await prisma.service.findMany({ include: { packItems: { include: { service: true } } } });
    const by = (n: string) => all.find((s) => s.name === n)!;
    expect(by("Site vitrine (5 pages)")).toMatchObject({ category: "SITE", unitPriceCents: 130_000, isSubscription: false });
    expect(by("Maintenance site")).toMatchObject({ category: null, isSubscription: true, billingInterval: "YEAR", unitPriceCents: 35_000 });
    for (const p of CATALOG_PACKS) {
      const pack = by(p.name);
      expect(pack.isPack, p.name).toBe(true);
      expect(pack.packItems.map((i) => i.service.name), p.name).toEqual(p.items);
      const detail = pack.packItems.filter((i) => !i.service.isSubscription).reduce((s, i) => s + i.service.unitPriceCents, 0);
      expect(pack.unitPriceCents, p.name).toBeLessThan(detail);
    }
    // Pack Vitrine : 1 300 + 150 = 1 450 € de détail, 1 400 € le pack (remise 50 €), maintenance au prix plein.
    expect(by("Pack Vitrine").unitPriceCents).toBe(140_000);
  });

  it("ancien nom : la prestation est reprise et renommée, sans doublon ; offre Stripe « (annuel) » reconnue et laissée telle quelle", async () => {
    const ancienne = await prisma.service.create({ data: { name: "Site vitrine (jusqu'à 5 pages)", unitPriceCents: 129_000, unit: "FORFAIT", active: true } });
    const stripe = await prisma.service.create({
      data: { name: "Maintenance site (annuel)", unitPriceCents: 30_000, unit: "FORFAIT", active: true, isSubscription: true, billingInterval: "YEAR", stripeProductId: "prod_m", stripePriceId: "price_m" },
    });
    const simulation = await applyCatalog(prisma, { dryRun: true, update: true });
    expect(simulation.find((a) => a.name === "Site vitrine (5 pages)")).toMatchObject({ action: "update", changes: expect.arrayContaining([expect.stringMatching(/^renommée/)]) });
    expect(simulation.find((a) => a.name === "Maintenance site (annuel)")).toMatchObject({ action: "stripe", changes: [expect.stringMatching(/cible : « Maintenance site », 350,00 € par an/)] });
    await applyCatalog(prisma, { update: true });
    expect(await prisma.service.findUniqueOrThrow({ where: { id: ancienne.id } })).toMatchObject({ name: "Site vitrine (5 pages)", unitPriceCents: 130_000 });
    expect(await prisma.service.count({ where: { name: { startsWith: "Site vitrine (" } } })).toBe(1);
    expect(await prisma.service.findUniqueOrThrow({ where: { id: stripe.id } })).toMatchObject({ unitPriceCents: 30_000, name: "Maintenance site (annuel)" });
    // Le pack se compose avec la maintenance pack (28/10/2026), sans créer une seconde « Maintenance site ».
    const pack = await prisma.service.findFirstOrThrow({ where: { name: "Pack Vitrine" }, include: { packItems: true } });
    expect(pack.packItems.map((i) => i.serviceId)).toContain(MAINTENANCE_PACK_ID);
    expect(await prisma.service.count({ where: { name: "Maintenance site" } })).toBe(0);
  });

  it("pack dont une prestation liée à Stripe garde son ancien nom : en attente jusqu'au renommage dans Prestations", async () => {
    await prisma.service.create({
      data: { name: "Fiche Google Maps (création ou optimisation)", unitPriceCents: 15_000, unit: "FORFAIT", active: true, stripeProductId: "prod_f", stripePriceId: "price_f" },
    });
    const actions = await applyCatalog(prisma, { update: true });
    expect(actions.find((a) => a.name === "Pack Vitrine")).toMatchObject({
      action: "blocked",
      changes: [expect.stringMatching(/« Fiche Google Maps » introuvable : la créer ou la renommer d'abord/)],
    });
    expect(await prisma.service.count({ where: { name: "Pack Vitrine" } })).toBe(0);
    // Packs sans cette prestation : créés normalement.
    expect(await prisma.service.count({ where: { name: "Pack Automatisation", isPack: true } })).toBe(1);
    // Une fois renommée dans Prestations, le pack se crée à la relance.
    await prisma.service.updateMany({ where: { stripeProductId: "prod_f" }, data: { name: "Fiche Google Maps" } });
    await applyCatalog(prisma, { update: true });
    expect(await prisma.service.count({ where: { name: "Pack Vitrine", isPack: true } })).toBe(1);
  });

});
