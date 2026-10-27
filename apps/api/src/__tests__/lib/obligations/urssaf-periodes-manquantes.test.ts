import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { syncObligationsLocal } from "@/lib/obligations/obligation-service.js";
import { listNotifications } from "@/lib/notifications/feed.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Défaut trouvé le 27/10/2026 : les déclarations URSSAF n'étaient planifiées que sur 18 mois (16 trimestres) depuis le
// début d'activité ; au-delà, plus aucune. Correction (conditions de github-2b) : aucune période entre le début d'activité
// et aujourd'hui n'est sautée ; création idempotente, sans doublon d'une déclaration existante (déclarée ou non) ; une
// ancienne période close jamais créée apparaît « à vérifier » (pas en retard), avec une notification à Alexandre.
const NOW = new Date(2026, 9, 10, 9);

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

async function settings(periodicity: "MONTHLY" | "QUARTERLY") {
  await prisma.companySettings.updateMany({ data: { businessStartDate: new Date(2025, 0, 1), urssafPeriodicity: periodicity } });
  invalidateCompanySettingsCache();
}

const urssaf = () => prisma.obligation.findMany({ where: { type: "URSSAF_DECLARATION" }, orderBy: { period: "asc" } });

function months(from: [number, number], to: [number, number]): string[] {
  const out: string[] = [];
  for (let y = from[0], m = from[1]; y < to[0] || (y === to[0] && m <= to[1]); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

describe("déclarations URSSAF depuis le début d'activité", () => {
  it("mensuel, début 01/2025, aujourd'hui 10/2026 : chaque mois présent une fois ; anciens « à vérifier », aucun en retard", async () => {
    await settings("MONTHLY");
    // Déclarations déjà faites ou existantes : ni doublon, ni changement d'état.
    await prisma.obligation.create({ data: { type: "URSSAF_DECLARATION", period: "2025-03", dueDate: new Date(2025, 3, 15), label: "Déclaration URSSAF : mars 2025", status: "DONE", completedAt: new Date(2025, 3, 10) } });
    const since = new Date(Date.now() - 1000);
    await syncObligationsLocal(NOW);
    await syncObligationsLocal(NOW);

    const rows = await urssaf();
    const periods = rows.map((r) => r.period);
    expect(new Set(periods).size).toBe(periods.length);
    for (const p of months([2025, 1], [2026, 9])) expect(periods, p).toContain(p);
    expect(rows.find((r) => r.period === "2025-03")!.status).toBe("DONE");
    // Mois clos depuis longtemps, créés au rattrapage : « à vérifier » ; jamais « en retard ».
    expect(rows.find((r) => r.period === "2025-06")!.status).toBe("TO_CHECK");
    expect(rows.filter((r) => r.status === "LATE")).toEqual([]);
    expect(rows.find((r) => r.period === "2026-09")!.status).toBe("PENDING");

    const notes = await listNotifications(since);
    const toCheck = notes.filter((n) => n.kind === "urssaf_to_check");
    expect(toCheck).toHaveLength(1);
    expect(toCheck[0]!.title).toMatch(/à vérifier/);
  });

  it("trimestriel, début 01/2025, aujourd'hui 10/2026 : chaque trimestre présent une fois", async () => {
    await settings("QUARTERLY");
    await syncObligationsLocal(NOW);
    await syncObligationsLocal(NOW);
    const rows = await urssaf();
    expect(rows.map((r) => r.period).filter((p) => p <= "2026-Q3")).toEqual(["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2", "2026-Q3"]);
    expect(rows.find((r) => r.period === "2025-Q2")!.status).toBe("TO_CHECK");
    expect(rows.filter((r) => r.status === "LATE")).toEqual([]);
  });

  it("passage du mensuel au trimestriel : mois déjà déclarés gardés, aucun trimestre qui les recouvre, trimestres suivants créés", async () => {
    await settings("MONTHLY");
    for (const p of months([2025, 1], [2025, 12])) {
      const [y, m] = p.split("-").map(Number) as [number, number];
      await prisma.obligation.create({ data: { type: "URSSAF_DECLARATION", period: p, dueDate: new Date(y, m, 15), label: `Déclaration URSSAF : ${p}`, status: "DONE", completedAt: new Date(y, m, 10) } });
    }
    await settings("QUARTERLY");
    await syncObligationsLocal(NOW);
    const rows = await urssaf();
    expect(rows.filter((r) => /^2025-\d\d$/.test(r.period) && r.status === "DONE")).toHaveLength(12);
    expect(rows.some((r) => r.period.startsWith("2025-Q"))).toBe(false);
    for (const q of ["2026-Q1", "2026-Q2", "2026-Q3"]) expect(rows.map((r) => r.period), q).toContain(q);
    expect(rows.filter((r) => r.status === "LATE")).toEqual([]);
  });
});
