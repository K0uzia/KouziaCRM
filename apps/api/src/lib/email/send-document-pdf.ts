import { InvoiceDocumentType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptOptional } from "@/lib/crypto";
import { getCompanySettings } from "@/lib/company";
import { listActiveLegalClauses } from "@/lib/company/legal-clauses";
import { isSmtpConfigured, sendEmail } from "@/lib/email/smtp";
import { buildInvoicePdfPayload, type ClientSnapshot } from "@/lib/pdf/build-payload";
import { renderInvoicePdf } from "@/lib/pdf/render";

export type SendDocumentPdfResult = {
  sent: boolean;
  reason?: "smtp_off" | "no_email" | "not_found" | "error";
};

export type SendDocumentPdfOptions = {
  subject?: string;
  text?: string;
  /** Si false, n'envoie pas (émission seule). Défaut true. */
  send?: boolean;
};

/**
 * Envoie le PDF d'un document émis (devis / facture / avoir) au client par SMTP.
 * Corps en texte brut uniquement (pas de HTML).
 * Ne jette pas : retourne { sent, reason } pour que l'émission reste prioritaire.
 */
export async function sendDocumentPdf(
  documentId: string,
  opts: SendDocumentPdfOptions = {},
): Promise<SendDocumentPdfResult> {
  if (opts.send === false) {
    return { sent: false };
  }
  if (!isSmtpConfigured()) {
    return { sent: false, reason: "smtp_off" };
  }

  try {
    const [company, legalClauses, invoice] = await Promise.all([
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
        },
      }),
    ]);

    if (!invoice || !invoice.number) {
      return { sent: false, reason: "not_found" };
    }

    const email = decryptOptional(invoice.client.emailEncrypted);
    if (!email) {
      return { sent: false, reason: "no_email" };
    }

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
      const { computeBalanceSummary } = await import(
        "@/lib/invoices/documentFlowService.js"
      );
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

    const pdf = await renderInvoicePdf({
      company,
      client: snapshot,
      invoice: buildInvoicePdfPayload({ invoice, legalClauses, balanceSummary }),
    });

    const isQuote = invoice.documentType === InvoiceDocumentType.QUOTE;
    const isCredit = invoice.documentType === InvoiceDocumentType.CREDIT_NOTE;
    const {
      buildEmailContent,
      brandFromSettings,
      pdfAttachmentFilename,
    } = await import("@/lib/email/templates.js");

    const brand = await brandFromSettings();
    const clientName = snapshot.displayName || "Client";
    const clientFirstName = snapshot.displayName?.split(/\s+/)[0] || null;

    let kind: import("@/lib/email/templates.js").EmailTemplateKind = "invoice";
    if (isQuote) kind = "quote";
    else if (isCredit) kind = "credit_note";
    else if (invoice.invoiceType === "ACOMPTE") kind = "invoice_acompte";
    else if (invoice.invoiceType === "SOLDE") kind = "invoice_solde";

    const built = buildEmailContent({
      kind,
      clientName,
      clientFirstName,
      docNumber: invoice.number,
      brand,
    });

    const replaceNumero = (s: string) =>
      s.replaceAll("{{numero}}", invoice.number ?? "").replaceAll("{{number}}", invoice.number ?? "");

    const text = replaceNumero((opts.text ?? built.text).trim());
    const subject = replaceNumero((opts.subject ?? built.subject).trim());
    const html = opts.text ? undefined : built.html;

    const attachKind = isQuote ? "Devis" : isCredit ? "Avoir" : "Facture";

    await sendEmail({
      to: email,
      subject,
      text,
      html,
      attachments: [
        {
          filename: pdfAttachmentFilename(attachKind, invoice.number, clientName),
          content: pdf,
          contentType: "application/pdf",
        },
      ],
    });

    return { sent: true };
  } catch (err) {
    console.error(`[email] envoi PDF échoué pour ${documentId}`, err);
    return { sent: false, reason: "error" };
  }
}
