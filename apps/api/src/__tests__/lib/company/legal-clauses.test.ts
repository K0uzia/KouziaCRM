import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegalClauseAudience, LegalClauseKind } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { clausesForClient, ensureDefaultLegalClauses, listActiveLegalClauses } from "@/lib/company/legal-clauses.js";
import { loadDocumentForPdf } from "@/lib/pdf/document-pdf.js";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  await resetDb();
});

const clause = (audience: LegalClauseAudience, title: string) => ({ audience, title });

describe("clauses légales par type de client", () => {
  it("tous : partout ; B2B ou B2C : seulement ce type ; type inconnu : « tous » seulement", () => {
    const list = [clause("ALL", "TVA"), clause("B2B", "Pénalités"), clause("B2C", "Intérêts")];
    expect(clausesForClient(list, "B2B").map((c) => c.title)).toEqual(["TVA", "Pénalités"]);
    expect(clausesForClient(list, "B2C").map((c) => c.title)).toEqual(["TVA", "Intérêts"]);
    expect(clausesForClient(list, null).map((c) => c.title)).toEqual(["TVA"]);
  });

  it("base neuve : pénalités et 40 € pour les professionnels, intérêts au taux légal pour les particuliers", async () => {
    await ensureDefaultLegalClauses();
    const penalties = await prisma.legalClause.findMany({ where: { kind: LegalClauseKind.PENALTY }, orderBy: { audience: "asc" } });
    expect(penalties.map((c) => c.audience)).toEqual([LegalClauseAudience.B2B, LegalClauseAudience.B2C]);
    expect(penalties[1]!.body).toContain("article 1231-6 du Code civil");
    expect(penalties[1]!.required).toBe(false);
  });

  it("clause des particuliers supprimée par l'admin : pas recréée au démarrage suivant", async () => {
    await ensureDefaultLegalClauses();
    await prisma.legalClause.deleteMany({ where: { audience: LegalClauseAudience.B2C } });
    await ensureDefaultLegalClauses();
    expect(await prisma.legalClause.count({ where: { audience: LegalClauseAudience.B2C } })).toBe(0);
  });

  it("PDF : un particulier n'a pas les pénalités ni les 40 €, un professionnel les a", async () => {
    const legalClauses = await listActiveLegalClauses();
    for (const [type, expected] of [["B2C", false], ["B2B", true]] as const) {
      const client = await createClient({ type, displayName: `Client ${type}` });
      const invoice = await prisma.invoice.create({
        data: {
          documentType: "INVOICE",
          invoiceType: "SIMPLE",
          status: "ISSUED",
          number: `F-2026-${type}`,
          clientId: client.id,
          subtotalCents: 10_000,
          totalCents: 10_000,
          issueDate: new Date(2026, 9, 1),
          lines: { create: { position: 1, description: "Site", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 } },
        },
      });
      const doc = (await loadDocumentForPdf(invoice.id))!;
      const payload = buildInvoicePdfPayload({ invoice: doc.invoice, legalClauses, clientType: doc.snapshot.type });
      const text = (payload.legalClauses ?? []).map((c) => c.body).join("\n");
      expect(text.includes("40 €")).toBe(expected);
      expect(text.includes("1231-6")).toBe(!expected);
      expect(text).toContain("TVA non applicable");
    }
  });
});
