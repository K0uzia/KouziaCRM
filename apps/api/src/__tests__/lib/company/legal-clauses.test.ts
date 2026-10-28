import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LegalClauseAudience, LegalClauseKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { clausesForClient, ensureDefaultLegalClauses, fillClauseVariables, listActiveLegalClauses, REPLACED_DEFAULT_BODIES, upgradeDefaultClauseTexts } from "@/lib/company/legal-clauses.js";
import { loadDocumentForPdf, renderLoadedDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { issueQuote } from "@/lib/invoices/transitions.js";
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

const clause = (audience: LegalClauseAudience, title: string) => ({ audience, kind: LegalClauseKind.CUSTOM, title });

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
    expect(penalties.map((c) => c.audience)).toEqual([LegalClauseAudience.B2B, LegalClauseAudience.NON_PROFESSIONAL]);
    expect(penalties[1]!.body).toContain("article 1231-6 du Code civil");
    expect(penalties[1]!.required).toBe(false);
  });

  it("clause des particuliers supprimée par l'admin : pas recréée au démarrage suivant", async () => {
    await ensureDefaultLegalClauses();
    const penalty = { audience: LegalClauseAudience.NON_PROFESSIONAL, kind: LegalClauseKind.PENALTY };
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
      // Variables remplies comme au rendu du PDF ({{mention_tva}} depuis le réglage).
      const text = (payload.legalClauses ?? []).map((c) => fillClauseVariables(c.body, doc.companyRaw)).join("\n");
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

  it("base neuve : une seule clause d'engagement, active, tout rythme de paiement, sans mention de brouillon", async () => {
    await ensureDefaultLegalClauses();
    const rows = await prisma.legalClause.findMany({ where: { kind: LegalClauseKind.SUBSCRIPTION_COMMITMENT } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Abonnement avec engagement", active: true });
    expect(rows[0]!.body).toContain("{{periodicite}}");
    expect(rows[0]!.body).not.toMatch(/\[BROUILLON|\[À FAIRE VALIDER|veille/);
  });

  it("base existante : ancien texte par défaut remplacé et gardé ; texte modifié par Alexandre jamais touché ; idempotent", async () => {
    await ensureDefaultLegalClauses();
    const OLD = REPLACED_DEFAULT_BODIES.find((r) => r.kind === LegalClauseKind.SUBSCRIPTION_COMMITMENT)!.oldBody;
    const commitment = await prisma.legalClause.findFirstOrThrow({ where: { title: "Abonnement avec engagement" } });
    await prisma.legalClause.update({ where: { id: commitment.id }, data: { body: OLD } });
    const annual = await prisma.legalClause.findFirstOrThrow({ where: { kind: LegalClauseKind.SUBSCRIPTION_ANNUAL } });
    await prisma.legalClause.update({ where: { id: annual.id }, data: { body: "Texte d'Alexandre." } });
    const now = new Date(2026, 9, 28, 18);
    expect(await upgradeDefaultClauseTexts(now)).toBe(1);
    const after = await prisma.legalClause.findUniqueOrThrow({ where: { id: commitment.id } });
    expect(after.body).not.toContain("[BROUILLON");
    expect(after.body).toContain("au plus tard un mois avant la fin de l'engagement");
    expect(after).toMatchObject({ previousBody: OLD, bodyReplacedAt: now, active: true });
    expect((await prisma.legalClause.findUniqueOrThrow({ where: { id: annual.id } })).body).toBe("Texte d'Alexandre.");
    expect(await upgradeDefaultClauseTexts(now)).toBe(0);
  });
});

describe("clauses figées à l'émission d'un devis (décision du 23/10/2026)", () => {
  async function quote(type: "B2B" | "B2C" = "B2B") {
    const client = await createClient({ type, displayName: `Client ${type}` });
    return prisma.invoice.create({
      data: {
        documentType: "QUOTE",
        status: "DRAFT",
        clientId: client.id,
        subtotalCents: 10_000,
        totalCents: 10_000,
        lines: { create: { position: 1, description: "Site", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000 } },
      },
    });
  }
  const printed = async (id: string) => {
    const doc = (await loadDocumentForPdf(id))!;
    return buildInvoicePdfPayload({ invoice: doc.invoice, legalClauses: doc.legalClauses, clientType: doc.snapshot.type }).legalClauses!.map((c) => c.body).join("\n");
  };

  it("devis émis puis clause modifiée : le PDF régénéré garde le texte d'origine ; un nouveau devis prend le nouveau", async () => {
    await ensureDefaultLegalClauses();
    const first = await quote();
    await issueQuote(first.id);
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: first.id } });
    expect(Array.isArray(stored.legalClausesSnapshot)).toBe(true);

    await prisma.legalClause.updateMany({ where: { kind: LegalClauseKind.SUSPENSION }, data: { body: "Nouveau texte de suspension." } });
    expect(await printed(first.id)).toContain("En cas de non-paiement d'une échéance, les prestations peuvent être suspendues");
    expect(await printed(first.id)).not.toContain("Nouveau texte de suspension.");
    expect((await renderLoadedDocumentPdf((await loadDocumentForPdf(first.id))!)).length).toBeGreaterThan(1000);

    const second = await quote();
    await issueQuote(second.id);
    expect(await printed(second.id)).toContain("Nouveau texte de suspension.");
  });

  it("instantané pour le type du client : un particulier n'emporte pas les pénalités des professionnels", async () => {
    await ensureDefaultLegalClauses();
    const q = await quote("B2C");
    await issueQuote(q.id);
    const snap = (await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).legalClausesSnapshot as Array<{ audience: string }>;
    expect(snap.every((c) => c.audience !== LegalClauseAudience.B2B)).toBe(true);
  });

  it("devis émis avant la migration (instantané nul) ou instantané illisible : clauses actives, comme avant", async () => {
    await ensureDefaultLegalClauses();
    const q = await quote();
    await issueQuote(q.id);
    await prisma.legalClause.updateMany({ where: { kind: LegalClauseKind.SUSPENSION }, data: { body: "Texte actif." } });
    await prisma.invoice.update({ where: { id: q.id }, data: { legalClausesSnapshot: Prisma.DbNull } });
    expect(await printed(q.id)).toContain("Texte actif.");
    await prisma.invoice.update({ where: { id: q.id }, data: { legalClausesSnapshot: [{ kind: "INCONNU" }] } });
    expect(await printed(q.id)).toContain("Texte actif.");
  });
});
