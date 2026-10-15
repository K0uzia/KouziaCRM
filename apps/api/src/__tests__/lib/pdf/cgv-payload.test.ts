import { describe, expect, it } from "vitest";
import { LegalClauseAudience, LegalClauseKind, type LegalClause } from "@prisma/client";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import { DEFAULT_LEGAL_CLAUSES, fillClauseVariables, MISSING_CONTACT_EMAIL } from "@/lib/company/legal-clauses.js";

const clauses = DEFAULT_LEGAL_CLAUSES.map((c, i) => ({
  id: `c${i}`,
  kind: c.kind,
  title: c.title,
  body: c.body,
  required: c.required,
  active: true,
  audience: c.audience ?? LegalClauseAudience.ALL,
  position: c.position,
  createdAt: new Date(),
  updatedAt: new Date(),
})) as LegalClause[];

function quote(interval: "MONTH" | "YEAR") {
  return {
    id: "q1",
    number: "D-2026-0001",
    documentType: "QUOTE",
    invoiceType: "SIMPLE",
    status: "ISSUED",
    quoteStatus: "SENT",
    paymentPlanOffer: "NONE",
    paymentPlan: null,
    depositBaseCents: null,
    discountType: "NONE",
    discountValue: 0,
    subtotalCents: 2900,
    totalCents: 2900,
    milestones: [],
    lines: [{ description: "Maintenance", quantity: 1, unitPriceCents: 2900, lineTotalCents: 2900, isSubscription: true, billingDay: 1, billingInterval: interval }],
  } as unknown as Parameters<typeof buildInvoicePdfPayload>[0]["invoice"];
}

describe("PDF du devis : abonnement, rétractation, CGV", () => {
  it("particulier : bloc de rétractation avec formulaire ; clauses dédiées hors des mentions", () => {
    const p = buildInvoicePdfPayload({ invoice: quote("MONTH"), legalClauses: clauses, clientType: "B2C" });
    expect(p.withdrawalTerms).toMatch(/14 jours/);
    expect(p.withdrawalTerms).toMatch(/Formulaire de rétractation/);
    expect(p.subscriptionTerms?.MONTH).toMatch(/Sans durée minimale/);
    expect(p.subscriptionTerms?.YEAR).toMatch(/reconduite tacitement/);
    const titles = (p.legalClauses ?? []).map((c) => c.title);
    expect(titles).not.toContain("Droit de rétractation (particuliers)");
    expect(titles).not.toContain("Abonnement mensuel");
    expect(p.cgv).toBeNull();
  });

  it("professionnel : pas de bloc de rétractation", () => {
    const p = buildInvoicePdfPayload({ invoice: quote("YEAR"), legalClauses: clauses, clientType: "B2B" });
    expect(p.withdrawalTerms).toBeNull();
    expect(p.subscriptionTerms?.YEAR).toMatch(/L215-1/);
  });

  it("CGV : lien et version seulement si publiées", () => {
    const off = buildInvoicePdfPayload({ invoice: quote("MONTH"), legalClauses: clauses, clientType: "B2C", cgv: { published: false, url: "https://kouzia.com/cgv", version: "2026-11-04" } });
    expect(off.cgv).toBeNull();
    const on = buildInvoicePdfPayload({ invoice: quote("MONTH"), legalClauses: clauses, clientType: "B2C", cgv: { published: true, url: "https://kouzia.com/cgv", version: "2026-11-04" } });
    expect(on.cgv).toEqual({ url: "https://kouzia.com/cgv", version: "2026-11-04" });
  });

  it("variables des clauses remplacées par les réglages", () => {
    const body = DEFAULT_LEGAL_CLAUSES.find((c) => c.kind === LegalClauseKind.WITHDRAWAL)!.body;
    const filled = fillClauseVariables(body, {
      legalName: "Alexandre Kouziaeff", tradeName: "Kouzia", email: "contact@kouzia.com",
      addressLine1: "13 Le Petit Moulin", addressLine2: null, postalCode: "29690", city: "Huelgoat",
    });
    expect(filled).toContain("à l'attention de Alexandre Kouziaeff, 13 Le Petit Moulin, 29690 Huelgoat, contact@kouzia.com");
    expect(filled).not.toMatch(/\{\{/);
  });

  it("e-mail absent : adresse d'envoi, sinon manque visible (jamais un blanc)", () => {
    const base = { legalName: "A", tradeName: null, addressLine1: "x", addressLine2: null, postalCode: "1", city: "y" };
    expect(fillClauseVariables("à {{email}}.", { ...base, email: null, smtpFrom: "Kouzia <contact@kouzia.com>" })).toBe("à contact@kouzia.com.");
    expect(fillClauseVariables("à {{email}}.", { ...base, email: " ", smtpFrom: null })).toBe(`à ${MISSING_CONTACT_EMAIL}.`);
  });
});
