import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { listActiveLegalClauses } from "@/lib/company/legal-clauses.js";
import { buildInvoicePdfPayload, type ClientSnapshot } from "@/lib/pdf/build-payload.js";
import { enrichCompanyForPdf } from "@/lib/pdf/brand-assets.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";

/**
 * Charge un document émis (devis, facture, avoir) avec tout ce qu'il faut pour son PDF.
 * Retourne null si le document n'existe pas ou n'a pas encore de numéro.
 */
export async function loadDocumentForPdf(documentId: string) {
  const [companyRaw, legalClauses, invoice] = await Promise.all([
    getCompanySettings(),
    listActiveLegalClauses(),
    prisma.invoice.findUnique({
      where: { id: documentId },
      include: {
        client: true,
        lines: { orderBy: { position: "asc" } },
        creditedInvoice: true,
        quote: true,
        sourceMilestone: true,
        milestones: { orderBy: { position: "asc" } },
        payments: { orderBy: { paidAt: "asc" } },
        quoteAcceptanceAudits: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
  ]);
  if (!invoice || !invoice.number) return null;

  const email = decryptOptional(invoice.client.emailEncrypted);
  const snapshot =
    (invoice.clientSnapshot as ClientSnapshot | null) ??
    ({
      displayName: invoice.client.displayName,
      type: invoice.client.type,
      email,
      phone: decryptOptional(invoice.client.phoneEncrypted),
      siret: decryptOptional(invoice.client.siretEncrypted),
      addressLine1: invoice.client.addressLine1,
      addressLine2: invoice.client.addressLine2,
      postalCode: invoice.client.postalCode,
      city: invoice.client.city,
      country: invoice.client.country,
    } satisfies ClientSnapshot);

  let balanceSummary = null;
  if (invoice.invoiceType === "SOLDE" && invoice.quoteId) {
    const { computeBalanceSummary } = await import("@/lib/invoices/documentFlowService.js");
    const s = await computeBalanceSummary(invoice.quoteId);
    balanceSummary = {
      marketTotalCents: s.marketTotalCents,
      quoteNumber: s.quoteNumber,
      acomptes: s.acomptes.map((a) => ({
        number: a.number,
        amountCents: a.amountCents,
        paid: a.paid,
        label: a.label,
        deductedCents: a.deductedCents,
      })),
      balanceDueCents: invoice.totalCents,
    };
  }

  return { companyRaw, legalClauses, invoice, email, snapshot, balanceSummary };
}

export type LoadedDocumentForPdf = NonNullable<Awaited<ReturnType<typeof loadDocumentForPdf>>>;

export async function renderLoadedDocumentPdf(doc: LoadedDocumentForPdf): Promise<Buffer> {
  return renderInvoicePdf({
    company: await enrichCompanyForPdf(doc.companyRaw),
    client: doc.snapshot,
    invoice: buildInvoicePdfPayload({
      invoice: doc.invoice,
      legalClauses: doc.legalClauses,
      balanceSummary: doc.balanceSummary,
    }),
  });
}

export async function renderDocumentPdf(documentId: string): Promise<Buffer | null> {
  const doc = await loadDocumentForPdf(documentId);
  return doc ? renderLoadedDocumentPdf(doc) : null;
}
