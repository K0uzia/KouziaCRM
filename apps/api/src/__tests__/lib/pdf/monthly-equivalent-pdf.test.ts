import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { renderDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

/** Texte du PDF tel qu'un lecteur le voit (pdf.js), espaces insécables ramenées à l'espace. */
async function pdfText(buf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    for (const it of content.items as Array<{ str?: string }>) if (it.str) parts.push(it.str);
  }
  await task.destroy();
  return parts.join(" ").replace(/[  ]/g, " ").replace(/\s+/g, " ");
}

async function documentWithAnnualLine(documentType: "QUOTE" | "INVOICE") {
  const client = await createClient({ displayName: "Exemple Annuel" });
  return prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType,
      // Pièce numérotée : le rendu PDF part d'une pièce émise (un brouillon passe par l'aperçu).
      number: documentType === "QUOTE" ? "D-2026-9001" : "F-2026-9001",
      status: "ISSUED",
      issueDate: new Date("2026-10-19T09:00:00Z"),
      ...(documentType === "QUOTE" ? { quoteStatus: "SENT" } : {}),
      subtotalCents: 35_000,
      totalCents: 35_000,
      lines: {
        create: [{ position: 0, description: "Maintenance annuelle", quantity: 1, unitPriceCents: 35_000, lineTotalCents: 35_000, isSubscription: true, billingInterval: "YEAR" }],
      },
    },
  });
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

describe("équivalent mensuel d'un abonnement annuel dans les PDF", () => {
  it("devis : « Soit 29,17 € par mois, à titre indicatif » sous la ligne ; prix dû toujours l'annuel", async () => {
    const quote = await documentWithAnnualLine("QUOTE");
    const text = await pdfText((await renderDocumentPdf(quote.id))!);
    expect(text).toContain("Soit 29,17 € par mois, à titre indicatif.");
    expect(text).toContain("350,00 €");
  }, 30_000);

  it("facture : jamais d'équivalent mensuel, le montant dû est l'annuel", async () => {
    const invoice = await documentWithAnnualLine("INVOICE");
    const text = await pdfText((await renderDocumentPdf(invoice.id))!);
    expect(text).not.toContain("par mois, à titre indicatif");
    expect(text).toContain("350,00 €");
  }, 30_000);
});
