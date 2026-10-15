import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegalClauseAudience, LegalClauseKind } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { buildEmailContent, brandFromSettings } from "@/lib/email/templates.js";
import { penaltyClauseText } from "@/lib/reminders/send.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  await resetDb();
});

const formal = async (penaltyText: string | null) =>
  (await buildEmailContent({ kind: "reminder_formal", clientName: "Client", docNumber: "F-2026-001", docLabel: "facture", brand: await brandFromSettings(), penaltyText })).text;

describe("mise en demeure : conditions de retard tirées des clauses des réglages", () => {
  it("professionnel : indemnité forfaitaire de 40 € (L441-10) ; particulier : jamais", async () => {
    const b2b = await penaltyClauseText("B2B");
    const b2c = await penaltyClauseText("B2C");
    expect(b2b).toMatch(/40 €/);
    expect(b2c).not.toMatch(/40 €|forfaitaire/);
    expect(await formal(b2b)).toContain(b2b!);
    const text = await formal(b2c);
    expect(text).toContain(b2c!);
    expect(text).not.toMatch(/40 €|forfaitaire/);
  });

  it("clause modifiée dans les réglages : le nouveau texte part tel quel ; sans clause, aucune mention chiffrée", async () => {
    await ensureDefaultLegalClauses();
    await prisma.legalClause.updateMany({
      where: { kind: LegalClauseKind.PENALTY, audience: LegalClauseAudience.B2B },
      data: { body: "Pénalités au taux de 10 % et indemnité forfaitaire de 40 € ({{raison_sociale}})." },
    });
    expect(await penaltyClauseText("B2B")).toBe("Pénalités au taux de 10 % et indemnité forfaitaire de 40 € (Test SARL).");

    await prisma.legalClause.updateMany({ where: { kind: LegalClauseKind.PENALTY }, data: { active: false } });
    expect(await penaltyClauseText("B2C")).toBeNull();
    const text = await formal(null);
    expect(text).toContain("les conditions de retard de paiement prévues au contrat");
    expect(text).not.toMatch(/40 €|forfaitaire/);
  });
});
