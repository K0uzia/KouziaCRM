import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { applyCatalog, CATALOG } from "@/lib/services/catalog.js";
import { resetDb } from "../../helpers/db.js";

beforeEach(async () => {
  await resetDb();
});

describe("import du catalogue", () => {
  it("simulation : rien n'est écrit", async () => {
    const actions = await applyCatalog(prisma, { dryRun: true });
    expect(actions.filter((a) => a.action === "create")).toHaveLength(CATALOG.length);
    expect(await prisma.service.count()).toBe(0);
  });

  it("relancé, il ne crée aucun doublon", async () => {
    await applyCatalog(prisma);
    const again = await applyCatalog(prisma);
    expect(again.every((a) => a.action === "same")).toBe(true);
    expect(await prisma.service.count()).toBe(CATALOG.length);
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
});
