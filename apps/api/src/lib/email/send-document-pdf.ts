import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { loadDocumentForPdf, renderLoadedDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { resolveInvoicePaymentUrl } from "@/lib/email/payment-url.js";

/** E-mail tel que l'ERP l'enverrait, pour la fenêtre « Vérifier l'e-mail » (rien n'est envoyé ni préparé). */
export type EmailDraft = { to: string; subject: string; text: string; attachments: string[] };

export type SendDocumentPdfResult = {
  sent: boolean;
  queued?: boolean;
  outboxId?: string;
  reason?: "smtp_off" | "no_email" | "not_found" | "error";
  /** Avec opts.draft : le brouillon, sans envoi. */
  draft?: EmailDraft;
};

export type SendDocumentPdfOptions = {
  subject?: string;
  text?: string;
  /** Si false, n'envoie pas (émission seule). Défaut true. */
  send?: boolean;
  threadId?: string;
  /**
   * Brouillon seulement (« Vérifier l'e-mail ») : objet, texte et pièces jointes, sans envoi ni effet de bord (le lien de
   * paiement n'est ni créé ni activé ; s'il manque au texte final, l'envoi l'ajoute comme d'habitude).
   */
  draft?: boolean;
  /** PDF déjà rendu (ex. devis signé archivé), joint tel quel au lieu d'être régénéré. */
  pdf?: Buffer;
  extraAttachments?: Array<{
    filename: string;
    contentBase64: string;
    contentType?: string;
  }>;
};

/**
 * Message rédigé à la main sans le lien de paiement : on l'ajoute avant la formule de
 * politesse (sinon en fin de message), pour que le bouton « Payer » apparaisse.
 */
function withPaymentLine(text: string, paymentUrl: string | null): string {
  if (!paymentUrl || text.includes(paymentUrl)) return text;
  const line = `Régler en ligne : ${paymentUrl}`;
  const closing = /\n\n(Cordialement|Bien à vous|Bien cordialement|Belle journée|Bonne journée|Merci)/i.exec(text);
  if (!closing) return `${text}\n\n${line}`;
  return `${text.slice(0, closing.index)}\n\n${line}${text.slice(closing.index)}`;
}

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
  if (!opts.draft && !(await isSmtpConfigured())) {
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
      // Brouillon : seulement un lien déjà existant (aucune session de paiement créée pour un simple aperçu).
      paymentUrl = opts.draft ? (invoice.checkoutUrl ?? invoice.sourceMilestone?.checkoutUrl ?? null) : await resolveInvoicePaymentUrl(invoice);
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

    const text = withPaymentLine(replaceNumero((opts.text ?? built.text).trim()), paymentUrl);
    const subject = replaceNumero((opts.subject ?? built.subject).trim());
    // HTML toujours reconstruit depuis le texte final (éventuellement modifié avant envoi).
    const { renderEmailHtml } = await import("@/lib/email/layout.js");
    const html = renderEmailHtml({ text, brand, colors: companyRaw, paymentUrl });

    const attachKind = isQuote ? "Devis" : isCredit ? "Avoir" : "Facture";
    const filename = pdfAttachmentFilename(attachKind, invoice.number, clientName);
    if (opts.draft) {
      return { sent: false, draft: { to: email, subject, text, attachments: [filename, ...(opts.extraAttachments ?? []).map((a) => a.filename)] } };
    }

    // Facture ou avoir émis : le PDF archivé part en pièce jointe (jamais un nouveau rendu).
    const { issuedDocumentPdf } = await import("@/lib/pdf/issued-archive.js");
    const pdf = opts.pdf ?? (await issuedDocumentPdf(documentId, doc)) ?? (await renderLoadedDocumentPdf(doc));

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
