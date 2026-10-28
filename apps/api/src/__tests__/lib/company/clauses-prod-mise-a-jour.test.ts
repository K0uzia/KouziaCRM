/**
 * Clauses relevées en production (rapport kouziactl audit du 28/10/2026, fixture sans donnée client, e-mail factice) :
 * upgradeDefaultClauseTexts remplace les clauses mensuelle, trimestrielle et annuelle, complète la clause d'engagement
 * active de l'exception de l'option, et ne touche ni la proposition supprimée ni les autres clauses.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { LegalClauseKind } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { upgradeDefaultClauseTexts } from "@/lib/company/legal-clauses.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

type ProdClause = { kind: LegalClauseKind; id: string; active: boolean; deleted: boolean; body: string };
const PROD: ProdClause[] = JSON.parse(readFileSync(new URL("../../fixtures/clauses-prod-28-10-2026.json", import.meta.url), "utf8"));

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.legalClause.deleteMany();
  for (const c of PROD) {
    await prisma.legalClause.create({ data: { id: c.id, kind: c.kind, title: c.kind, body: c.body, active: c.active, deletedAt: c.deleted ? new Date(2026, 9, 27) : null } });
  }
});

const row = (id: string) => prisma.legalClause.findUniqueOrThrow({ where: { id } });

describe("mise à jour des clauses de la production (28/10/2026)", () => {
  it("mensuelle, annuelle, trimestrielle remplacées ; engagement complété ; proposition supprimée et autres clauses intactes", async () => {
    expect(await upgradeDefaultClauseTexts(new Date(2026, 9, 28, 20))).toBe(4);

    for (const id of ["cmv9unbag0000p304894rc3ss", "cmv9unc0p0001p304m8mdgper", "cmvkznsoz0000p3htovr7zzzc"]) {
      const before = PROD.find((c) => c.id === id)!;
      const after = await row(id);
      expect(after.previousBody).toBe(before.body);
      expect(after.body).not.toMatch(/Résiliable à tout moment|veille|Sans durée minimale/);
      expect(after.body).toMatch(/au plus tard un mois avant la fin de l'année en cours/);
      expect(after.active).toBe(true);
    }

    const commitment = PROD.find((c) => c.id === "cmvfxb4on0000p3dmle075zt7")!;
    const after = await row(commitment.id);
    expect(after.previousBody).toBe(commitment.body);
    expect(after.body).toBe(
      commitment.body.replace(
        "à compter de la signature du devis",
        "à compter de la signature du devis (pour une option retenue sur un devis payé une fois, à compter de la livraison, date à laquelle l'abonnement démarre)",
      ),
    );
    expect(after.body).toContain("contact@exemple.test");

    const proposal = await row("cmvpoarjl0000p36a2bn02tjb");
    expect(proposal).toMatchObject({ body: PROD.find((c) => c.id === proposal.id)!.body, active: false, previousBody: null });
    expect(proposal.deletedAt).not.toBeNull();

    const touched = new Set(["cmv9unbag0000p304894rc3ss", "cmv9unc0p0001p304m8mdgper", "cmvkznsoz0000p3htovr7zzzc", "cmvfxb4on0000p3dmle075zt7"]);
    for (const c of PROD.filter((x) => !touched.has(x.id))) {
      expect(await row(c.id)).toMatchObject({ body: c.body, active: c.active, previousBody: null });
    }

    // Idempotent.
    expect(await upgradeDefaultClauseTexts()).toBe(0);
  });
});
