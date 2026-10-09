import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { isSmtpConfigured } from "@/lib/email/smtp";
import { mailEnqueue } from "@/lib/email/mailer";
import { loadDocumentForPdf, renderLoadedDocumentPdf } from "@/lib/pdf/document-pdf";
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
  /** PDF déjà rendu (ex. devis signé archivé), joint tel quel au lieu d'être régénéré. */
  pdf?: Buffer;
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
    const doc = await loadDocumentForPdf(documentId);
    if (!doc) {
      return { sent: false, reason: "not_found" };
    }
    const { companyRaw, invoice, email, snapshot } = doc;
    if (!email || !invoice.number) {
      return { sent: false, reason: "no_email" };
    }

    const pdf = opts.pdf ?? (await renderLoadedDocumentPdf(doc));

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
