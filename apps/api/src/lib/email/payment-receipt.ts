import { invoiceBalance } from "@/lib/invoices/balance.js";
import { InvoiceDocumentType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import type { ReviewOptions } from "@/lib/email/review.js";
import { formatEUR } from "@/lib/money.js";
import { getCompanySettings } from "@/lib/company.js";
import { brandFromSettings } from "@/lib/email/templates.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { sendDocumentPdf, type SendDocumentPdfResult } from "@/lib/email/send-document-pdf.js";
import { paymentReceiptPdf, receiptFileName } from "@/lib/pdf/receipt-archive.js";
import { templateText } from "@/lib/email/template-registry.js";

/**
 * E-mail « Paiement reçu » : le REÇU de ce règlement (archivé) et la facture telle qu'émise (archivée).
 * La facture émise ne change pas avec les paiements : l'état « réglée » est porté par le reçu.
 * Règlement visé : `paymentId`, sinon le dernier enregistré sur la facture pour ce montant. Ne jette pas.
 */
export async function sendPaymentReceipt(
  invoiceId: string,
  amountCents: number,
  paymentId?: string,
  /** « Vérifier l'e-mail » : brouillon seul (aucun PDF rendu), ou objet et texte relus. */
  opts: { draft?: boolean; subject?: string; text?: string; review?: ReviewOptions } = {},
): Promise<SendDocumentPdfResult> {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        client: { select: { displayName: true, firstName: true } },
        payments: { select: { id: true, amountCents: true, paidAt: true, createdAt: true } },
        creditNotes: { select: { totalCents: true, payments: { select: { amountCents: true } } } },
        quote: { select: { number: true } },
      },
    });
    if (!invoice || invoice.documentType !== InvoiceDocumentType.INVOICE || !invoice.number) {
      return { sent: false, reason: "not_found" };
    }
    const payment =
      invoice.payments.find((p) => p.id === paymentId) ??
      [...invoice.payments]
        .filter((p) => p.amountCents === amountCents)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const receipt = payment && !opts.draft ? await paymentReceiptPdf(payment.id) : null;
    const withReceipt = opts.draft ? Boolean(payment) : Boolean(receipt);

    // Reste à régler avoirs compris (net moins encaissé net).
    const remaining = invoiceBalance(invoice).dueCents;
    const firstName = (invoice.client.firstName || invoice.client.displayName).trim().split(/\s+/)[0];
    const what =
      invoice.invoiceType === "ACOMPTE"
        ? `la facture d'acompte {{numero}}${invoice.quote?.number ? ` (devis ${invoice.quote.number})` : ""}`
        : invoice.invoiceType === "SOLDE"
          ? "la facture de solde {{numero}}"
          : "la facture {{numero}}";
    const attached = withReceipt
      ? "Vous trouverez ci-joint le reçu de ce paiement et la facture {{numero}}."
      : "Vous trouverez ci-joint la facture {{numero}}.";
    const signature = formatPlainTextSignature(await getCompanySettings(), await brandFromSettings());
    const salutation = firstName ? `Bonjour ${firstName},` : "Bonjour,";
    const state = remaining === 0 ? "La facture est entièrement réglée." : `Il reste ${formatEUR(remaining)} à régler.`;
    const nextStep = invoice.invoiceType === "ACOMPTE" && remaining === 0 ? "Le projet démarre : je reviens vers vous très vite pour les prochaines étapes." : "";
    const body = [
      salutation,
      "",
      `Nous avons bien reçu votre paiement de ${formatEUR(amountCents)} pour ${what}. Merci !`,
      `${state} ${attached}`,
      ...(nextStep ? ["", nextStep] : []),
    ].join("\n");
    // Modèle modifié dans Réglages (M3a) : objet et texte remplis ; sinon le texte ci-dessus.
    const content = await templateText(
      "payment.receipt",
      {
        salutation,
        numero: invoice.number,
        montant: formatEUR(amountCents),
        document: what,
        facture_reglee: remaining === 0 ? "réglée" : "",
        etat_reglement: state,
        pieces_jointes: attached,
        suite_projet: nextStep,
      },
      { subject: remaining === 0 ? "Paiement reçu : facture {{numero}} réglée" : "Paiement reçu : facture {{numero}}", body },
    );
    const text = [content.body, "", signature].join("\n");
    return await sendDocumentPdf(invoice.id, {
      subject: opts.subject?.trim() || content.subject,
      text: opts.text?.trim() || text,
      draft: opts.draft,
      review: opts.review,
      extraAttachments: withReceipt && payment
        ? [
            {
              filename: receiptFileName(invoice.number, payment.paidAt, payment.id),
              contentBase64: receipt ? receipt.toString("base64") : "",
              contentType: "application/pdf",
            },
          ]
        : [],
    });
  } catch (err) {
    console.error(`[email] reçu de paiement impossible pour ${invoiceId}`, err);
    return { sent: false, reason: "error" };
  }
}
