import { writeArchiveFile } from "@/lib/pdf/archive-file.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { loadDocumentForPdf, pdfDataOfLoaded, renderLoadedDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { sendDocumentPdf } from "@/lib/email/send-document-pdf.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { brandFromSettings } from "@/lib/email/templates.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { formatDateTimeLongFr, formatLongDateFr } from "@/lib/format-fr.js";
import { formatEUR } from "@/lib/money.js";
import { INTERVAL_LABEL, type BillingIntervalChoice } from "@/lib/quotes/interval-choice.js";
import { periodWord } from "@/lib/subscriptions/subscription-service.js";

const SIGNED_QUOTES_DIR = "signed-quotes";

export function signedQuoteAbsolutePath(pdfPath: string): string {
  return path.resolve(process.cwd(), "data", "uploads", pdfPath);
}

/**
 * Rend le devis tel que le client le lit avant de signer, et calcule son empreinte SHA-256.
 * Cette empreinte, imprimée sur le devis signé, prouve que le document accepté est
 * exactement le fichier archivé : la moindre modification la changerait.
 */
export async function captureQuoteBeforeSignature(
  quoteId: string,
): Promise<{ pdf: Buffer; sha256: string; number: string } | null> {
  try {
    const doc = await loadDocumentForPdf(quoteId);
    if (!doc) return null;
    // Devis émis : le PDF figé à l'émission, celui que le client a reçu ; sinon (devis jamais émis) le rendu du moment.
    const { issuedDocumentPdf } = await import("@/lib/pdf/issued-archive.js");
    const pdf = (await issuedDocumentPdf(quoteId, doc)) ?? (await renderLoadedDocumentPdf(doc));
    return {
      pdf,
      sha256: createHash("sha256").update(pdf).digest("hex"),
      number: doc.invoice.number ?? "devis",
    };
  } catch (err) {
    console.error(`[quote] rendu du devis avant signature impossible pour ${quoteId}`, err);
    return null;
  }
}

export async function archiveOriginalQuote(
  auditId: string,
  original: { pdf: Buffer; number: string },
): Promise<void> {
  try {
    const safeNumber = original.number.replace(/[^A-Za-z0-9_-]/g, "_");
    const originalPdfPath = `${SIGNED_QUOTES_DIR}/${safeNumber}-${auditId}-avant-signature.pdf`;
    const abs = signedQuoteAbsolutePath(originalPdfPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeArchiveFile(abs, original.pdf);
    await prisma.quoteAcceptanceAudit.update({ where: { id: auditId }, data: { originalPdfPath } });
  } catch (err) {
    console.error(`[quote] archive du devis avant signature impossible (${auditId})`, err);
  }
}

function fmtDate(d: Date): string {
  return formatLongDateFr(d);
}

function fmtDateTime(d: Date): string {
  return formatDateTimeLongFr(d);
}

/**
 * Archive le PDF du devis tel qu'accepté (bloc « Bon pour accord »), enregistre son
 * empreinte SHA-256 sur la trace d'acceptation, puis envoie le devis signé au client.
 * Ne jette pas : l'acceptation est déjà actée, la preuve est un complément.
 */
export async function recordQuoteAcceptanceProof(
  auditId: string,
  quoteId: string,
  opts: { sendConfirmation?: boolean } = {},
): Promise<void> {
  try {
    const doc = await loadDocumentForPdf(quoteId);
    if (!doc) return;
    const pdf = await renderLoadedDocumentPdf(doc);
    const pdfSha256 = createHash("sha256").update(pdf).digest("hex");

    const safeNumber = (doc.invoice.number ?? "devis").replace(/[^A-Za-z0-9_-]/g, "_");
    const pdfPath = `${SIGNED_QUOTES_DIR}/${safeNumber}-${auditId}.pdf`;
    const abs = signedQuoteAbsolutePath(pdfPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeArchiveFile(abs, pdf);

    await prisma.quoteAcceptanceAudit.update({
      where: { id: auditId },
      data: { pdfPath, pdfSha256 },
    });
    // Version lisible du devis signé : figée maintenant, seulement si son texte est celui du PDF archivé.
    const { readableInvoice, snapshotFor } = await import("@/lib/pdf/readable-documents.js");
    const readable = await snapshotFor(pdf, readableInvoice(await pdfDataOfLoaded(doc), "ARCHIVE"));
    await prisma.invoice.update({ where: { id: quoteId }, data: { readableSnapshot: readable.snapshot } });

    if (opts.sendConfirmation === false) return;

    const audit = await prisma.quoteAcceptanceAudit.findUniqueOrThrow({ where: { id: auditId } });
    const firstName = doc.snapshot.displayName?.split(/\s+/)[0];
    const signature = formatPlainTextSignature(await getCompanySettings(), await brandFromSettings());
    const text = [
      firstName ? `Bonjour ${firstName},` : "Bonjour,",
      "",
      `Nous avons bien reçu votre accord sur le devis {{numero}}, validé au nom de « ${audit.signerName} » le ${fmtDateTime(audit.createdAt)}.`,
      "Vous trouverez ci-joint le devis signé. Conservez-le avec cet e-mail.",
      ...((doc.invoice.paymentPlan ?? audit.paymentPlan)
        ? [
            "",
            doc.invoice.billingMode
              ? (doc.invoice.paymentPlan ?? audit.paymentPlan) === "ONE"
                ? "Formule de paiement retenue : comptant, à régler maintenant."
                : `Formule de paiement retenue : en ${(doc.invoice.paymentPlan ?? audit.paymentPlan) === "THREE" ? 3 : 2} fois, à parts égales ; les dates des échéances sont dans votre espace client.`
              : (doc.invoice.paymentPlan ?? audit.paymentPlan) === "THREE"
                ? "Formule de paiement retenue : en 3 fois. Le 2e acompte sera demandé à l'étape du projet indiquée dans votre espace client."
                : "Formule de paiement retenue : en 2 fois (acompte puis solde).",
          ]
        : []),
      // Rythme au choix (28/10/2026) : celui retenu à la signature, avec le montant d'une échéance.
      ...(audit.billingInterval && audit.billingPeriodCents !== null
        ? ["", `Rythme de paiement retenu : ${INTERVAL_LABEL[audit.billingInterval as BillingIntervalChoice]?.toLowerCase() ?? audit.billingInterval}, ${formatEUR(audit.billingPeriodCents)} par ${periodWord(audit.billingInterval)}.`]
        : []),
      ...(audit.cgvAccepted && audit.cgvUrl && audit.cgvVersion
        ? ["", `Conditions générales de vente acceptées : version du ${audit.cgvVersion}, ${audit.cgvUrl}`]
        : []),
      // Particulier : rappel du délai de rétractation (le devis joint en détaille les modalités).
      ...(audit.consumer && audit.withdrawalEndsAt
        ? [
            "",
            `Vous pouvez vous rétracter jusqu'au ${fmtDate(audit.withdrawalEndsAt)} inclus (modalités et formulaire dans le devis joint).`,
            audit.expressExecution
              ? "À votre demande, la prestation peut commencer avant la fin de ce délai."
              : "Sans demande de démarrage anticipé de votre part, la prestation commencera au plus tôt le lendemain de cette date.",
          ]
        : []),
      "",
      `La suite du projet est consultable dans votre espace client : ${await resolveClientPortalUrl()}`,
      "",
      signature,
    ].join("\n");

    await sendDocumentPdf(quoteId, {
      pdf,
      subject: "Devis {{numero}} signé : confirmation",
      text,
      threadId: audit.threadId ?? undefined,
      review: { family: "signature_confirmation", origin: "CLIENT_ACTION", clientWaiting: true },
    });
  } catch (err) {
    console.error(`[quote] preuve d'acceptation impossible pour ${quoteId}`, err);
  }
}
