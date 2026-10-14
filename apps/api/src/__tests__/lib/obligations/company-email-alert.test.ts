import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { listObligationsDashboard } from "@/lib/obligations/obligation-service.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  await resetDb();
});

const emailAlert = async () => (await listObligationsDashboard()).alerts.find((a) => a.kind === "company-email");

describe("rappel : e-mail de l'entreprise vide", () => {
  it("vide ou blanc : rappel en tête des alertes ; renseigné : plus de rappel", async () => {
    for (const email of [null, "   "]) {
      await prisma.companySettings.updateMany({ data: { email } });
      invalidateCompanySettingsCache();
      const alerts = (await listObligationsDashboard()).alerts;
      expect(alerts[0]?.kind).toBe("company-email");
      expect(alerts[0]?.message).toContain("Les alertes importantes ne vous parviennent pas");
    }
    await prisma.companySettings.updateMany({ data: { email: "contact@kouzia.test" } });
    invalidateCompanySettingsCache();
    expect(await emailAlert()).toBeUndefined();
  });
});
