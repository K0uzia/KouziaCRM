import { InvoiceDocumentType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { formatEUR } from "@/lib/money.js";
import { getCompanySettings } from "@/lib/company.js";
import { brandFromSettings } from "@/lib/email/templates.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { sendDocumentPdf, type SendDocumentPdfResult } from "@/lib/email/send-document-pdf.js";

/**
 * Reçu de paiement envoyé au client : email avec la facture en PDF, à jour du règlement
 * (« acquittée » si soldée, sinon reste dû). Ne jette pas.
 */
export async function sendPaymentReceipt(
  invoiceId: string,
  amountCents: number,
): Promise<SendDocumentPdfResult> {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        client: { select: { displayName: true, firstName: true } },
        payments: { select: { amountCents: true } },
        quote: { select: { number: true } },
      },
    });
    if (!invoice || invoice.documentType !== InvoiceDocumentType.INVOICE || !invoice.number) {
      return { sent: false, reason: "not_found" };
    }
    const paid = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
    const remaining = Math.max(0, invoice.totalCents - paid);
    const firstName = (invoice.client.firstName || invoice.client.displayName).trim().split(/\s+/)[0];
    const what =
      invoice.invoiceType === "ACOMPTE"
        ? `la facture d'acompte {{numero}}${invoice.quote?.number ? ` (devis ${invoice.quote.number})` : ""}`
        : invoice.invoiceType === "SOLDE"
          ? "la facture de solde {{numero}}"
          : "la facture {{numero}}";
    const signature = formatPlainTextSignature(await getCompanySettings(), await brandFromSettings());
    const text = [
      firstName ? `Bonjour ${firstName},` : "Bonjour,",
      "",
      `Nous avons bien reçu votre paiement de ${formatEUR(amountCents)} pour ${what}. Merci !`,
      remaining === 0
        ? "La facture est entièrement réglée : vous la trouverez ci-jointe, marquée acquittée. Elle vaut reçu."
        : `Il reste ${formatEUR(remaining)} à régler. Vous trouverez ci-joint la facture à jour de ce paiement.`,
      ...(invoice.invoiceType === "ACOMPTE" && remaining === 0
        ? ["", "Le projet démarre : je reviens vers vous très vite pour les prochaines étapes."]
        : []),
      "",
      signature,
    ].join("\n");
    return await sendDocumentPdf(invoice.id, {
      subject: remaining === 0 ? "Paiement reçu : facture {{numero}} acquittée" : "Paiement reçu : facture {{numero}}",
      text,
    });
  } catch (err) {
    console.error(`[email] reçu de paiement impossible pour ${invoiceId}`, err);
    return { sent: false, reason: "error" };
  }
}
