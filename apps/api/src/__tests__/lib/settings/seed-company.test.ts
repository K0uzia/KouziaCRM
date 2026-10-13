import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { ensureCompanySettings, INITIAL_COMPANY_SETTINGS } from "@/lib/settings/seed-company.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
});
afterEach(async () => {
  await resetDb();
});

describe("seed des réglages (kouziactl admin le relance)", () => {
  it("base neuve : création avec les valeurs initiales explicites (2 acomptes 30/70), sans médiateur fictif", async () => {
    // resetDb garde la ligne de réglages : base neuve simulée.
    await prisma.companySettings.deleteMany();
    expect(await ensureCompanySettings(prisma)).toBe("created");
    const s = await prisma.companySettings.findFirstOrThrow();
    expect(s).toMatchObject({
      treasuryRateBps: INITIAL_COMPANY_SETTINGS.treasuryRateBps,
      depositCount: 2,
      depositPercent1Bps: 3000,
      depositPercent2Bps: 7000,
      depositPercent3Bps: 0,
      mediationClause: null,
    });
  });

  it("relancé : aucun réglage choisi dans l'ERP n'est écrasé", async () => {
    await seedCompanySettings();
    await prisma.companySettings.updateMany({
      data: {
        treasuryRateBps: 2500,
        placementRateBps: 0,
        urssafPeriodicity: "QUARTERLY",
        publicTrackingShowAmounts: false,
        depositCount: 3,
        depositPercent1Bps: 2000,
        depositPercent2Bps: 3000,
        depositPercent3Bps: 5000,
      },
    });
    const before = await prisma.companySettings.findFirstOrThrow();
    expect(await ensureCompanySettings(prisma)).toBe("kept");
    const after = await prisma.companySettings.findFirstOrThrow();
    expect(after).toMatchObject({
      treasuryRateBps: 2500,
      placementRateBps: 0,
      urssafPeriodicity: "QUARTERLY",
      publicTrackingShowAmounts: false,
      depositCount: 3,
      depositPercent1Bps: 2000,
      depositPercent2Bps: 3000,
      depositPercent3Bps: 5000,
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("ancienne répartition par défaut exacte (3 acomptes 30/40/30) : corrigée en 2 acomptes 30/70", async () => {
    await seedCompanySettings();
    await prisma.companySettings.updateMany({
      data: { depositCount: 3, depositPercent1Bps: 3000, depositPercent2Bps: 4000, depositPercent3Bps: 3000 },
    });
    await ensureCompanySettings(prisma);
    expect(await prisma.companySettings.findFirstOrThrow()).toMatchObject({
      depositCount: 2,
      depositPercent1Bps: 3000,
      depositPercent2Bps: 7000,
      depositPercent3Bps: 0,
    });
  });
});
