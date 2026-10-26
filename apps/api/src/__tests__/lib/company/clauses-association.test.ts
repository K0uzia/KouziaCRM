import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { ensureDefaultLegalClauses, fillClauseVariables, listActiveLegalClauses } from "@/lib/company/legal-clauses.js";
import { penaltyClauseText } from "@/lib/reminders/send.js";
import { loadDocumentForPdf } from "@/lib/pdf/document-pdf.js";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Défaut du 26/10/2026 : un client ASSOCIATION (non-professionnel) ne recevait aucune clause de retard (ni celle des
// professionnels, ni celle des particuliers), sur ses devis, ses factures et sa relance formelle. Attendu : la clause du
// Code civil (art. 1231-6), jamais l'indemnité de 40 € du Code de commerce, jamais les clauses de consommateur.
beforeEach(async () => {
  await resetDb();
  await prisma.legalClause.deleteMany({});
  await seedCompanySettings();
  await ensureDefaultLegalClauses();
});

type ClientKind = "B2B" | "B2C" | "ASSOCIATION";
const EXPECTED: Record<ClientKind, { civil: boolean; forty: boolean; withdrawal: boolean }> = {
  B2B: { civil: false, forty: true, withdrawal: false },
  B2C: { civil: true, forty: false, withdrawal: true },
  ASSOCIATION: { civil: true, forty: false, withdrawal: false },
};

async function documentText(type: ClientKind, documentType: "QUOTE" | "INVOICE") {
  const client = await createClient({ type, displayName: `Client ${type} ${documentType}` });
  const invoice = await prisma.invoice.create({
    data: {
      documentType,
      invoiceType: "SIMPLE",
      status: "ISSUED",
      number: `${documentType === "QUOTE" ? "D" : "F"}-2026-${type}`,
      clientId: client.id,
      subtotalCents: 10_000,
      totalCents: 10_000,
      issueDate: new Date(2026, 9, 1),
      lines: { create: { position: 1, description: "Site", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 } },
    },
  });
  const doc = (await loadDocumentForPdf(invoice.id))!;
  const payload = buildInvoicePdfPayload({ invoice: doc.invoice, legalClauses: await listActiveLegalClauses(), clientType: doc.snapshot.type });
  return {
    text: (payload.legalClauses ?? []).map((c) => fillClauseVariables(c.body, doc.companyRaw)).join("\n"),
    withdrawal: Boolean(payload.withdrawalTerms),
  };
}

describe("clauses de retard selon le type de client", () => {
  for (const type of ["ASSOCIATION", "B2B", "B2C"] as const) {
    for (const documentType of ["QUOTE", "INVOICE"] as const) {
      it(`${type}, ${documentType === "QUOTE" ? "devis" : "facture"} : bonne clause de retard`, async () => {
        const { text } = await documentText(type, documentType);
        expect(text.includes("1231-6")).toBe(EXPECTED[type].civil);
        expect(text.includes("40 €")).toBe(EXPECTED[type].forty);
      });
    }

    it(`${type}, relance formelle : bonne clause de retard`, async () => {
      const penalty = await penaltyClauseText(type);
      expect(penalty).not.toBeNull();
      expect(penalty!.includes("1231-6")).toBe(EXPECTED[type].civil);
      expect(penalty!.includes("40 €")).toBe(EXPECTED[type].forty);
    });
  }

  it("base existante (clause des particuliers en B2C) : rien d'automatique ; couverte dès qu'Alexandre choisit « Associations et particuliers »", async () => {
    const civil = await prisma.legalClause.findFirstOrThrow({ where: { kind: "PENALTY", audience: "NON_PROFESSIONAL" } });
    await prisma.legalClause.update({ where: { id: civil.id }, data: { audience: "B2C" } });
    expect(await penaltyClauseText("ASSOCIATION")).toBeNull();
    expect((await documentText("ASSOCIATION", "INVOICE")).text.includes("1231-6")).toBe(false);
    expect((await penaltyClauseText("B2C"))!.includes("1231-6")).toBe(true);

    await prisma.legalClause.update({ where: { id: civil.id }, data: { audience: "NON_PROFESSIONAL" } });
    expect((await penaltyClauseText("ASSOCIATION"))!.includes("1231-6")).toBe(true);
  });

  it("public « Associations » : seulement les associations", async () => {
    await prisma.legalClause.create({ data: { kind: "CUSTOM", title: "Mention associations", body: "Texte réservé aux associations.", audience: "ASSOCIATION", position: 50 } });
    expect((await documentText("ASSOCIATION", "QUOTE")).text).toContain("Texte réservé aux associations.");
    expect((await documentText("B2C", "QUOTE")).text).not.toContain("Texte réservé aux associations.");
    expect((await documentText("B2B", "QUOTE")).text).not.toContain("Texte réservé aux associations.");
  });

  it("association : jamais les clauses de consommateur (rétractation)", async () => {
    for (const type of ["ASSOCIATION", "B2B", "B2C"] as const) {
      expect((await documentText(type, "QUOTE")).withdrawal, type).toBe(EXPECTED[type].withdrawal);
    }
  });
});
