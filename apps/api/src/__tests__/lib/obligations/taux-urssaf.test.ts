import { beforeEach, describe, expect, it } from "vitest";
import { computeSocialChargesForEncaisse } from "@/lib/publicodes.js";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { syncObligationsLocal } from "@/lib/obligations/obligation-service.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Décision du 27/10/2026 : le calcul URSSAF (modele-social) est vérifié contre les taux attendus d'une micro-entreprise
// en activité libérale non réglementée (BNC, affiliée à la Sécurité sociale des indépendants), sans ACRE, en 2026 :
// - cotisations sociales : 25,6 % du chiffre d'affaires au 1er janvier 2026 (21,1 % en 2023, 23,1 % de juillet 2024,
//   24,6 % en 2025 ; le palier de 26,1 % prévu en 2024 a été ramené à 25,6 %) ;
// - contribution à la formation professionnelle (CFP) d'une activité libérale : 0,2 %.
// Un écart se signale ici (test en échec), il ne se corrige pas en changeant l'attendu.
describe("taux URSSAF de la micro-entreprise BNC non réglementée", () => {
  it("1 000 € encaissés : 256 € de cotisations, 2 € de CFP, 258 € au total", () => {
    const r = computeSocialChargesForEncaisse(100_000);
    expect(r.cotisationsCents).toBe(25_600);
    expect(r.cfpCents).toBe(200);
    expect(r.totalCents).toBe(25_800);
    expect(r.effectiveRateBps).toBe(2_580);
  });

  it("proportionnel au montant : un trimestre (montant trois fois plus grand) garde le même taux", () => {
    const month = computeSocialChargesForEncaisse(250_000);
    const quarter = computeSocialChargesForEncaisse(750_000);
    expect(quarter.effectiveRateBps).toBe(month.effectiveRateBps);
    expect(quarter.totalCents).toBe(month.totalCents * 3);
  });

  it("gros trimestre (25 000 €) : même taux, pas d'effet de plafond annuel", () => {
    const r = computeSocialChargesForEncaisse(2_500_000);
    expect(r.effectiveRateBps).toBe(2_580);
  });

  // Écart du 27/10/2026, corrigé : le taux est celui de la période déclarée, pas celui de la date du calcul.
  it("taux de la période déclarée : décembre 2025 à 24,6 %, juin 2024 à 21,1 %, janvier 2026 à 25,6 %", () => {
    expect(computeSocialChargesForEncaisse(100_000, new Date(2025, 11, 1)).cotisationsCents).toBe(24_600);
    expect(computeSocialChargesForEncaisse(100_000, new Date(2024, 5, 1)).cotisationsCents).toBe(21_100);
    expect(computeSocialChargesForEncaisse(100_000, new Date(2026, 0, 1)).cotisationsCents).toBe(25_600);
  });
});

describe("déclaration URSSAF de décembre 2025, calculée en janvier 2026", () => {
  beforeEach(async () => {
    await resetDb();
    await seedCompanySettings();
    await prisma.companySettings.updateMany({ data: { businessStartDate: new Date(2025, 0, 1), urssafPeriodicity: "MONTHLY" } });
    invalidateCompanySettingsCache();
  });

  it("1 000 € encaissés en décembre 2025 : 246 € de cotisations + 2 € de CFP, au taux de décembre 2025", async () => {
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: { clientId: client.id, documentType: "INVOICE", status: "PAID", number: "F-2025-0001", issueDate: new Date(2025, 11, 10), subtotalCents: 100_000, totalCents: 100_000 },
    });
    await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 100_000, paidAt: new Date(2025, 11, 15, 12), method: "BANK_TRANSFER" } });
    await syncObligationsLocal(new Date(2026, 0, 10, 9));
    const december = await prisma.obligation.findFirst({ where: { type: "URSSAF_DECLARATION", period: "2025-12" } });
    expect(december?.amountCents).toBe(24_800);
  });
});
