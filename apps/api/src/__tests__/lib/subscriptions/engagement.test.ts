import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { acceptQuoteByClient, issueQuote } from "@/lib/invoices/transitions.js";
import { cancellableTermOf, commitmentEndOf, currentTermEndOf, isUnderCommitment } from "@/lib/subscriptions/commitment.js";
import { buildInvoicePdfPayload } from "@/lib/pdf/build-payload.js";
import { loadDocumentForPdf, renderLoadedDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  invalidateCompanySettingsCache();
});

afterEach(async () => {
  await resetDb();
});

/** Devis d'abonnement annuel « tout compris », avec ou sans engagement, émis. */
async function issuedQuote(commitmentMonths: number | null) {
  const client = await createClient({ displayName: "Atelier Lou", type: "B2B" });
  const service = await createService({ name: "Site vitrine tout compris", unitPriceCents: 150_000, isSubscription: true });
  const quote = await prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      subtotalCents: 150_000,
      totalCents: 150_000,
      lines: {
        create: [{
          position: 1, description: "Site vitrine tout compris", quantity: 1, unitPriceCents: 150_000, lineTotalCents: 150_000,
          isSubscription: true, billingDay: 1, billingInterval: "YEAR", serviceId: service.id, commitmentMonths,
        }],
      },
    },
  });
  await issueQuote(quote.id);
  return quote.id;
}

describe("durée d'engagement d'un abonnement", () => {
  it("fin d'engagement : même jour du mois, ramené au dernier jour d'un mois plus court", () => {
    expect(commitmentEndOf(new Date(2026, 9, 19), 36)).toEqual(new Date(2029, 9, 19));
    expect(commitmentEndOf(new Date(2026, 0, 31), 1)).toEqual(new Date(2026, 1, 28));
    expect(commitmentEndOf(new Date(2027, 0, 31), 13)).toEqual(new Date(2028, 1, 29));
    expect(isUnderCommitment({ commitmentEndsAt: new Date(2029, 9, 19) }, new Date(2029, 9, 18))).toBe(true);
    expect(isUnderCommitment({ commitmentEndsAt: new Date(2029, 9, 19) }, new Date(2029, 9, 20))).toBe(false);
    expect(isUnderCommitment({ commitmentEndsAt: null })).toBe(false);
  });

  it("devis signé : l'abonnement reçoit la durée et la fin d'engagement, comptée depuis la signature", async () => {
    const quoteId = await issuedQuote(36);
    await acceptQuoteByClient(quoteId, "Lou Cliente", { source: "ADMIN" });
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } });
    const sub = await prisma.subscription.findFirstOrThrow();
    expect(sub.commitmentMonths).toBe(36);
    expect(sub.commitmentEndsAt).toEqual(commitmentEndOf(quote.quoteDecidedAt!, 36));
    expect(sub.amountCents).toBe(150_000);
  });

  it("sans engagement : rien de changé (ni durée ni fin)", async () => {
    const quoteId = await issuedQuote(null);
    await acceptQuoteByClient(quoteId, "Lou Cliente", { source: "ADMIN" });
    expect(await prisma.subscription.findFirstOrThrow()).toMatchObject({ commitmentMonths: null, commitmentEndsAt: null });
  });

  it("PDF du devis : clause d'engagement (CGV du 28/10/2026) à la place de la clause annuelle, rendu sans erreur", async () => {
    const quoteId = await issuedQuote(36);
    const doc = (await loadDocumentForPdf(quoteId))!;
    const payload = buildInvoicePdfPayload({
      invoice: doc.invoice,
      legalClauses: doc.legalClauses,
      clientType: doc.snapshot.type,
      balanceSummary: doc.balanceSummary,
      planSettings: doc.companyRaw,
      cgv: { published: false, url: null, version: null },
    });
    expect(payload.lines[0]).toMatchObject({ commitmentMonths: 36 });
    expect(payload.subscriptionTerms?.COMMITMENT).not.toMatch(/\[BROUILLON|\[À FAIRE VALIDER/);
    expect(payload.subscriptionTerms?.COMMITMENT).toContain("les échéances restant à courir jusqu'à la fin de l'engagement restent dues");
    expect((await renderLoadedDocumentPdf(doc)).length).toBeGreaterThan(1000);
  });
});

describe("période en cours d'un abonnement engagé (décision du 23/10/2026)", () => {
  it("fin de l'engagement, puis de chaque année reconduite ; date limite un mois avant, incluse", () => {
    const end = new Date(2027, 0, 31);
    expect(currentTermEndOf(end, new Date(2026, 5, 1))).toEqual(end);
    expect(currentTermEndOf(end, new Date(2027, 1, 1))).toEqual(new Date(2028, 0, 31));
    expect(cancellableTermOf(end, new Date(2026, 11, 31, 18))).toEqual({ termEndsAt: end, cancelDeadline: new Date(2026, 11, 31) });
    expect(cancellableTermOf(end, new Date(2027, 0, 1))).toEqual({ termEndsAt: new Date(2028, 0, 31), cancelDeadline: new Date(2027, 11, 31) });
    // 31 mars : date limite au dernier jour de février.
    expect(cancellableTermOf(new Date(2027, 2, 31), new Date(2027, 0, 1)).cancelDeadline).toEqual(new Date(2027, 1, 28));
  });
});
