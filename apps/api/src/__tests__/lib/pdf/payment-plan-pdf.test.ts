import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { acceptQuoteByClient, issueQuote } from "@/lib/invoices/transitions.js";
import { generateMilestoneInvoice } from "@/lib/invoices/documentFlowService.js";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import { loadDocumentForPdf, renderLoadedDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { projectInputSchema, updateClientProject } from "@/lib/projects/service.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  invalidateCompanySettingsCache();
});

afterEach(async () => {
  await resetDb();
});

async function issuedChoiceQuote() {
  const client = await createClient({ displayName: "Boulangerie Martin" });
  const quote = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: 129_000,
      totalCents: 129_000,
      paymentPlanOffer: "CHOICE",
      lines: { create: [{ position: 1, description: "Site vitrine", quantity: 1, unitPriceCents: 129_000, lineTotalCents: 129_000 }] },
    },
  });
  await issueQuote(quote.id);
  return { quoteId: quote.id, clientId: client.id };
}

async function payloadOf(id: string) {
  const doc = (await loadDocumentForPdf(id))!;
  const pdf = await renderLoadedDocumentPdf(doc);
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  return buildInvoicePdfPayload({ invoice: doc.invoice, legalClauses: doc.legalClauses, planSettings: doc.companyRaw });
}

describe("PDF du paiement en 2 ou 3 fois", () => {
  it("devis au choix non signé : les deux échéanciers avec leurs montants", async () => {
    const { quoteId } = await issuedChoiceQuote();
    const p = await payloadOf(quoteId);
    expect(p.paymentPlanChoice?.map((c) => c.title)).toEqual(["Paiement en 2 fois", "Paiement en 3 fois"]);
    expect(p.paymentPlanChoice?.[1]?.milestones.map((m) => m.amountCents)).toEqual([38_700, 51_600, 38_700]);
    expect(p.paymentPlanRetained).toBeNull();
  });

  it("devis signé en 3 fois : formule retenue et seul l'échéancier retenu", async () => {
    const { quoteId } = await issuedChoiceQuote();
    await acceptQuoteByClient(quoteId, "Paul Martin", { paymentPlan: "THREE" });
    const p = await payloadOf(quoteId);
    expect(p.paymentPlanChoice).toBeNull();
    expect(p.paymentPlanRetained).toBe("Paiement en 3 fois");
    expect(p.milestones).toHaveLength(3);
  });

  it("facture du 2e acompte : étape de projet déclencheuse imprimée", async () => {
    const { quoteId, clientId } = await issuedChoiceQuote();
    await acceptQuoteByClient(quoteId, "Paul Martin", { paymentPlan: "THREE" });
    const project = await prisma.clientProject.create({ data: { clientId, name: "Site", quoteId } });
    await updateClientProject(
      project.id,
      projectInputSchema.parse({
        name: "Site",
        progress: 60,
        steps: [{ label: "Maquette validée", status: "done", triggersDeposit2: true }],
      }),
    );
    const m2 = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId, position: 2 } });
    const invoice = await generateMilestoneInvoice(m2.id);
    const p = await payloadOf(invoice.id);
    expect(p.milestoneTriggerStep?.label).toBe("Maquette validée");
  });
});
