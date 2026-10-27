import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { readClientSnapshot } from "@/lib/invoices/client-snapshot.js";
import { getCompanySettings } from "@/lib/company.js";
import { LegalClauseKind } from "@prisma/client";
import { documentClauses, fillClauseVariables, listActiveLegalClauses, VAT_MENTION_VARIABLE } from "@/lib/company/legal-clauses.js";
import { buildInvoicePdfPayload, type ClientSnapshot } from "@/lib/pdf/build-payload.js";
import { enrichCompanyForPdf } from "@/lib/pdf/brand-assets.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";
import type { InvoicePdfData } from "@/lib/pdf/invoice-document.js";

/**
 * Charge un document émis (devis, facture, avoir) avec tout ce qu'il faut pour son PDF et sa version lisible : seule
 * source du PDF admin, du PDF et de la version lisible publics, de l'archive et du gel (P0 du 25/10/2026 : un chargement
 * à part avait oublié les propositions et le code promo). Retourne null si le document n'existe pas ou n'a pas de numéro.
 * maskContacts : lien public, contacts du client absents du repli sans instantané (comme avant).
 */
export async function loadDocumentForPdf(documentId: string, opts: { maskContacts?: boolean } = {}) {
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
        promoCode: { select: { code: true, conditionText: true } },
        options: { orderBy: { position: "asc" }, include: { promoCode: { select: { code: true, conditionText: true } } } },
        sourceMilestone: true,
        milestones: { orderBy: { position: "asc" } },
        payments: { orderBy: { paidAt: "asc" } },
        // Rendu de secours d'une facture sans archive : avoirs et remboursements pour le reste dû.
        creditNotes: { select: { totalCents: true, createdAt: true, payments: { select: { amountCents: true, createdAt: true } } } },
        quoteAcceptanceAudits: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
  ]);
  if (!invoice || !invoice.number) return null;

  const email = decryptOptional(invoice.client.emailEncrypted);
  const snapshot =
    (readClientSnapshot(invoice) as ClientSnapshot | null) ??
    ({
      displayName: invoice.client.displayName,
      type: invoice.client.type,
      email: opts.maskContacts ? null : email,
      phone: opts.maskContacts ? null : decryptOptional(invoice.client.phoneEncrypted),
      siret: opts.maskContacts ? null : decryptOptional(invoice.client.siretEncrypted),
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

  // Devis émis : clauses figées à l'émission, sinon clauses actives.
  return { companyRaw, legalClauses: documentClauses(invoice, legalClauses), invoice, email, snapshot, balanceSummary };
}

export type LoadedDocumentForPdf = NonNullable<Awaited<ReturnType<typeof loadDocumentForPdf>>>;

/** Données du gabarit : une seule source pour le PDF et sa version lisible. */
export async function pdfDataOfLoaded(doc: LoadedDocumentForPdf): Promise<InvoicePdfData> {
  const company = await enrichCompanyForPdf(doc.companyRaw);
  const isQuote = doc.invoice.documentType === "QUOTE";
  // Devis aux clauses figées : la mention de TVA sous les totaux est celle figée à l'émission, pas le réglage du jour.
  const frozenVat = isQuote && doc.invoice.legalClausesSnapshot != null ? doc.legalClauses.find((c) => c.kind === LegalClauseKind.VAT) : undefined;
  // Facture ou avoir qui reprend les clauses du devis : la mention de TVA est celle du réglage à la date du document.
  const legalClauses = isQuote ? doc.legalClauses : doc.legalClauses.map((c) => (c.kind === LegalClauseKind.VAT ? { ...c, body: VAT_MENTION_VARIABLE } : c));
  return {
    company: frozenVat ? { ...company, vatMention: fillClauseVariables(frozenVat.body, company) } : company,
    client: doc.snapshot,
    invoice: buildInvoicePdfPayload({
      invoice: doc.invoice,
      legalClauses,
      clientType: doc.snapshot.type,
      balanceSummary: doc.balanceSummary,
      planSettings: doc.companyRaw,
      cgv: { published: doc.companyRaw.cgvPublished, url: doc.companyRaw.cgvUrl, version: doc.companyRaw.cgvVersion },
    }),
  };
}

export async function renderLoadedDocumentPdf(doc: LoadedDocumentForPdf): Promise<Buffer> {
  return renderInvoicePdf(await pdfDataOfLoaded(doc));
}

export async function renderDocumentPdf(documentId: string): Promise<Buffer | null> {
  const doc = await loadDocumentForPdf(documentId);
  return doc ? renderLoadedDocumentPdf(doc) : null;
}
