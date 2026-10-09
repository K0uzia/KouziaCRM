import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { loadDocumentForPdf, renderLoadedDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { sendDocumentPdf } from "@/lib/email/send-document-pdf.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { brandFromSettings } from "@/lib/email/templates.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";

const SIGNED_QUOTES_DIR = "signed-quotes";

export function signedQuoteAbsolutePath(pdfPath: string): string {
  return path.resolve(process.cwd(), "data", "uploads", pdfPath);
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long", timeStyle: "short" });
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
    await fs.writeFile(abs, pdf);

    await prisma.quoteAcceptanceAudit.update({
      where: { id: auditId },
      data: { pdfPath, pdfSha256 },
    });

    if (opts.sendConfirmation === false) return;

    const audit = await prisma.quoteAcceptanceAudit.findUniqueOrThrow({ where: { id: auditId } });
    const firstName = doc.snapshot.displayName?.split(/\s+/)[0];
    const signature = formatPlainTextSignature(await getCompanySettings(), await brandFromSettings());
    const text = [
      firstName ? `Bonjour ${firstName},` : "Bonjour,",
      "",
      `Nous avons bien reçu votre accord sur le devis {{numero}}, validé au nom de « ${audit.signerName} » le ${fmtDateTime(audit.createdAt)}.`,
      "Vous trouverez ci-joint le devis signé. Conservez-le avec cet e-mail.",
      "",
      `Empreinte SHA-256 du document : ${pdfSha256}`,
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
    });
  } catch (err) {
    console.error(`[quote] preuve d'acceptation impossible pour ${quoteId}`, err);
  }
}
