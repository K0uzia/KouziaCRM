import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptOptional } from "@/lib/crypto";
import { getCompanySettings } from "@/lib/company";
import { listActiveLegalClauses } from "@/lib/company/legal-clauses";
import { isSmtpConfigured } from "@/lib/email/smtp";
import { mailEnqueue } from "@/lib/email/mailer";
import { buildInvoicePdfPayload, type ClientSnapshot } from "@/lib/pdf/build-payload";
import { enrichCompanyForPdf } from "@/lib/pdf/brand-assets";
import { renderInvoicePdf } from "@/lib/pdf/render";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { resolveInvoicePaymentUrl } from "@/lib/email/payment-url.js";

export type SendDocumentPdfResult = {
  sent: boolean;
  queued?: boolean;
  outboxId?: string;
  reason?: "smtp_off" | "no_email" | "not_found" | "error";
};

export type SendDocumentPdfOptions = {
  subject?: string;
  text?: string;
  /** Si false, n'envoie pas (émission seule). Défaut true. */
  send?: boolean;
  threadId?: string;
  extraAttachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType?: string;
  }>;
};

/**
 * Génère le PDF et enfile l'envoi email via EmailOutbox (worker).
 * Ne jette pas : retourne { sent, queued, outboxId, reason }.
 */
export async function sendDocumentPdf(
  documentId: string,
  opts: SendDocumentPdfOptions = {},
): Promise<SendDocumentPdfResult> {
  if (opts.send === false) {
    return { sent: false };
  }
  if (!(await isSmtpConfigured())) {
    return { sent: false, reason: "smtp_off" };
  }

  try {
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
        },
      }),
    ]);
    const company = await enrichCompanyForPdf(companyRaw);

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
    const portalUrl = await resolveClientPortalUrl();

    let kind: import("@/lib/email/templates.js").EmailTemplateKind = "invoice";
    if (isQuote) kind = "quote";
    else if (isCredit) kind = "credit_note";
    else if (invoice.invoiceType === "ACOMPTE") kind = "invoice_acompte";
    else if (invoice.invoiceType === "SOLDE") kind = "invoice_solde";

    let paymentUrl: string | null = null;
    if (!isQuote && !isCredit && invoice.status !== InvoiceStatus.PAID) {
      paymentUrl = await resolveInvoicePaymentUrl(invoice);
    }

    const built = await buildEmailContent({
      kind,
      clientName,
      clientFirstName,
      docNumber: invoice.number,
      brand,
      clientPortalUrl: portalUrl,
      paymentUrl,
      brandPrimaryColor: companyRaw.brandPrimaryColor,
    });

    const replaceNumero = (s: string) =>
      s.replaceAll("{{numero}}", invoice.number ?? "").replaceAll("{{number}}", invoice.number ?? "");

    const text = replaceNumero((opts.text ?? built.text).trim());
    const subject = replaceNumero((opts.subject ?? built.subject).trim());
    const html = opts.text ? (paymentUrl ? built.html : undefined) : built.html;

    const attachKind = isQuote ? "Devis" : isCredit ? "Avoir" : "Facture";
    const filename = pdfAttachmentFilename(attachKind, invoice.number, clientName);

    const { outboxId } = await mailEnqueue({
      to: email,
      subject,
      text,
      html,
      clientId: invoice.clientId,
      documentId: invoice.id,
      documentNumber: invoice.number,
      threadId: opts.threadId,
      kind,
      bodyTextForMessage: text,
      attachments: [
        {
          filename,
          contentBase64: pdf.toString("base64"),
          contentType: "application/pdf",
        },
        ...(opts.extraAttachments ?? []),
      ],
    });

    return { sent: true, queued: true, outboxId };
  } catch (err) {
    console.error(`[email] enqueue PDF échoué pour ${documentId}`, err);
    return { sent: false, reason: "error" };
  }
}
