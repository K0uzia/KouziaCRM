import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { listObligationsDashboard } from "@/lib/obligations/obligation-service.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { b2cActivity: false, mediationClause: null } });
  invalidateCompanySettingsCache();
});
afterEach(async () => {
  await resetDb();
});

const mediationAlert = async () => (await listObligationsDashboard()).alerts.find((a) => a.kind === "mediation");

describe("rappel médiation de la consommation", () => {
  it("aucun particulier : pas de rappel", async () => {
    await createClient({ type: "B2B", displayName: "Société" });
    expect(await mediationAlert()).toBeUndefined();
  });

  it("un client particulier sans médiateur renseigné : rappel ; médiateur renseigné : plus de rappel", async () => {
    await createClient({ type: "B2C", displayName: "Lou Martin" });
    expect((await mediationAlert())?.message).toContain("Réglages > Mentions légales");
    await prisma.companySettings.updateMany({ data: { mediationClause: "Médiateur : CM2C, 49 rue de Ponthieu, 75008 Paris, www.cm2c.net" } });
    invalidateCompanySettingsCache();
    expect(await mediationAlert()).toBeUndefined();
  });

  it("case « je facture des particuliers » cochée, sans client particulier encore : rappel", async () => {
    await prisma.companySettings.updateMany({ data: { b2cActivity: true } });
    invalidateCompanySettingsCache();
    expect(await mediationAlert()).toBeDefined();
  });
});
