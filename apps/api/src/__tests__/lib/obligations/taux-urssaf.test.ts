import { describe, expect, it } from "vitest";
import { computeSocialChargesForEncaisse } from "@/lib/publicodes.js";

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
});
