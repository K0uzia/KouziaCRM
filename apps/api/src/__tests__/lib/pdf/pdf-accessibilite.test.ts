import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { renderDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { renderChartePreviewPdf } from "@/lib/pdf/charte-preview.js";
import { renderReceiptsPdf } from "@/lib/pdf/render.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

/** Langue, titre et texte dans l'ordre du flux, tels qu'un lecteur de PDF les lit (pdf.js). */
async function readPdf(buf: Buffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const { info } = (await doc.getMetadata()) as { info: { Title?: string; Language?: string | null } };
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    for (const it of content.items as Array<{ str?: string }>) if (it.str) parts.push(it.str);
  }
  await task.destroy();
  const raw = buf.toString("latin1");
  return {
    title: info.Title,
    language: info.Language,
    // Sans DisplayDocTitle, le lecteur annonce le nom du fichier au lieu du titre.
    displayDocTitle: /\/DisplayDocTitle true/.test(raw),
    text: parts.join(" ").replace(/[  ]/g, " ").replace(/\s+/g, " "),
  };
}

/**
 * Chaque extrait apparaît après le précédent dans l'ordre de lecture. Comparaison sans espaces : les intitulés
 * espacés (letterSpacing) sont extraits lettre par lettre (« F A C T U R E »).
 */
function expectInOrder(text: string, excerpts: string[]) {
  const flat = text.replace(/\s+/g, "");
  let from = 0;
  for (const raw of excerpts) {
    const e = raw.replace(/\s+/g, "");
    const at = flat.indexOf(e, from);
    expect(at, `« ${e} » après la position ${from}`).toBeGreaterThanOrEqual(0);
    from = at + e.length;
  }
}

async function issued(documentType: "QUOTE" | "INVOICE" | "CREDIT_NOTE", number: string) {
  const client = await createClient({ displayName: "Client Lecture" });
  return prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType,
      number,
      status: "ISSUED",
      issueDate: new Date("2026-10-24T09:00:00Z"),
      ...(documentType === "QUOTE" ? { quoteStatus: "SENT" } : {}),
      subtotalCents: 30_000,
      totalCents: 30_000,
      lines: { create: [{ position: 0, description: "Site vitrine", quantity: 1, unitPriceCents: 30_000, lineTotalCents: 30_000 }] },
    },
  });
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

describe("PDF accessibles (lot A) : langue, titre et ordre de lecture", () => {
  it.each([
    ["QUOTE", "D-2026-9101", "Devis D-2026-9101", "DEVIS"],
    ["INVOICE", "F-2026-9101", "Facture F-2026-9101", "FACTURE"],
    ["CREDIT_NOTE", "A-2026-9101", "Avoir A-2026-9101", "AVOIR"],
  ] as const)("%s : langue fr, titre en casse normale affiché, lecture de l'en-tête au pied", async (type, number, title, heading) => {
    const doc = await issued(type, number);
    const pdf = await readPdf((await renderDocumentPdf(doc.id))!);
    expect(pdf.language).toBe("fr");
    expect(pdf.title).toBe(title);
    expect(pdf.displayDocTitle).toBe(true);
    // Émetteur, intitulé, client, lignes, total, mentions légales, numéro de page : l'ordre visuel.
    expectInOrder(pdf.text, ["Test", heading, number, "Client Lecture", "Site vitrine", "300,00 €", "TVA non applicable", "Page 1 / 1"]);
  }, 30_000);

  it("aperçu de la charte : titre sans numéro fictif, langue fr", async () => {
    const pdf = await readPdf(await renderChartePreviewPdf("INVOICE", { brandPrimaryColor: "#f59e0b", brandSecondaryColor: "#0f172a" }));
    expect(pdf.language).toBe("fr");
    expect(pdf.title).toBe("Facture EXEMPLE");
  }, 30_000);

  it("reçu de paiement et livre des recettes : langue fr et titre", async () => {
    const receipt = await readPdf(await renderChartePreviewPdf("RECEIPT", { brandPrimaryColor: "#f59e0b", brandSecondaryColor: "#0f172a" }));
    expect(receipt.language).toBe("fr");
    expect(receipt.title).toBe("Reçu de paiement EXEMPLE");
    expect(receipt.displayDocTitle).toBe(true);

    const book = await readPdf(
      await renderReceiptsPdf({
        year: 2026,
        editedAt: new Date("2026-10-24T09:00:00Z"),
        company: { legalName: "Test SARL", tradeName: "Test", siret: "12345678900011", addressLine1: "1 rue Test", postalCode: "75001", city: "Paris" },
        rows: [],
        totalCents: 0,
      }),
    );
    expect(book.language).toBe("fr");
    expect(book.title).toBe("Livre des recettes 2026");
    expect(book.displayDocTitle).toBe(true);
  }, 30_000);
});
