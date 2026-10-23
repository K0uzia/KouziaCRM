import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegalClauseAudience, LegalClauseKind } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { clausesForClient, ensureDefaultLegalClauses, fillClauseVariables, listActiveLegalClauses } from "@/lib/company/legal-clauses.js";
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
    const penalty = { audience: LegalClauseAudience.B2C, kind: LegalClauseKind.PENALTY };
    await prisma.legalClause.deleteMany({ where: penalty });
    await ensureDefaultLegalClauses();
    expect(await prisma.legalClause.count({ where: penalty })).toBe(0);
  });

  it("droit de rétractation (information obligatoire) : recréé s'il manque", async () => {
    await ensureDefaultLegalClauses();
    await prisma.legalClause.deleteMany({ where: { kind: LegalClauseKind.WITHDRAWAL } });
    await ensureDefaultLegalClauses();
    expect(await prisma.legalClause.count({ where: { kind: LegalClauseKind.WITHDRAWAL, audience: LegalClauseAudience.B2C } })).toBe(1);
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

describe("clauses d'abonnement : {{periode}} et {{periodicite}}", () => {
  const company = { legalName: "A", tradeName: null, email: "a@b.fr", addressLine1: "x", addressLine2: null, postalCode: "1", city: "y" };
  const body = "payable d'avance {{periodicite}}, par périodes d'un {{periode}}";

  it("remplies selon la périodicité ; laissées telles quelles hors abonnement", () => {
    expect(fillClauseVariables(body, company, "MONTH")).toBe("payable d'avance chaque mois, par périodes d'un mois");
    expect(fillClauseVariables(body, company, "QUARTER")).toBe("payable d'avance chaque trimestre, par périodes d'un trimestre");
    expect(fillClauseVariables(body, company, "YEAR")).toBe("payable d'avance chaque année à la date anniversaire, par périodes d'un an");
    expect(fillClauseVariables(body, company)).toBe(body);
  });

  it("proposition d'engagement créée inactive, sans toucher au texte d'Alexandre ; brouillon signalé", async () => {
    await ensureDefaultLegalClauses();
    const actuel = await prisma.legalClause.findFirstOrThrow({ where: { title: "Abonnement avec engagement" } });
    await prisma.legalClause.update({ where: { id: actuel.id }, data: { body: "Texte d'Alexandre." } });
    await prisma.legalClause.deleteMany({ where: { title: { startsWith: "Abonnement avec engagement (" } } });
    await ensureDefaultLegalClauses();
    const rows = await prisma.legalClause.findMany({ where: { kind: LegalClauseKind.SUBSCRIPTION_COMMITMENT }, orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ body: "Texte d'Alexandre.", active: true });
    expect(rows[1]).toMatchObject({ active: false, required: false });
    expect(rows[1]!.body).toMatch(/^\[BROUILLON/);
    expect(rows[1]!.body).toContain("{{periodicite}}");
    // Inactive : le PDF garde le texte actuel.
    const active = await listActiveLegalClauses();
    expect(active.filter((c) => c.kind === LegalClauseKind.SUBSCRIPTION_COMMITMENT).map((c) => c.body)).toEqual(["Texte d'Alexandre."]);
  });
});
