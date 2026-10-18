import { describe, expect, it } from "vitest";
import React from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { PaymentReceiptDocument, type PaymentReceiptPdfData } from "@/lib/pdf/payment-receipt-document.js";

type Item = { str: string; x: number; y: number; w: number; h: number };

/** Texte du PDF tel qu'un lecteur le voit : morceaux avec position (pdf.js), regroupés en lignes. */
async function readPdf(buf: Buffer): Promise<{ items: Item[]; lines: string[] }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Lecture du texte seulement : pas de rendu des glyphes, donc pas besoin des polices standard de pdf.js.
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const items: Item[] = [];
  for (const it of content.items as Array<{ str?: string; transform?: number[]; width?: number; height?: number }>) {
    if (!it.str?.trim() || !it.transform) continue;
    items.push({ str: it.str, x: it.transform[4]!, y: it.transform[5]!, w: it.width ?? 0, h: Math.abs(it.transform[3]!) });
  }
  const byLine = new Map<number, Item[]>();
  for (const it of items) {
    const key = [...byLine.keys()].find((y) => Math.abs(y - it.y) < 1) ?? it.y;
    byLine.set(key, [...(byLine.get(key) ?? []), it]);
  }
  const lines = [...byLine.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map((i) => i.str).join(" ").replace(/\s+/g, " ").trim());
  await task.destroy();
  return { items, lines };
}

const company: PaymentReceiptPdfData["company"] = {
  legalName: "Exemple SARL",
  tradeName: "Exemple",
  siret: "00000000000000",
  addressLine1: "1 rue de l'Exemple",
  postalCode: "33000",
  city: "Bordeaux",
  email: null,
  vatMention: "TVA non applicable, art. 293 B du CGI",
};

const CASES: Array<[string, PaymentReceiptPdfData]> = [
  [
    "paiement complet par virement",
    {
      company,
      client: { displayName: "Exemple Atelier", addressLine1: "12 rue de l'Exemple", postalCode: "33000", city: "Bordeaux" },
      payment: { paidAt: new Date("2026-10-10T08:00:00Z"), amountCents: 180_000, methodLabel: "virement", reference: "VIR-0001" },
      invoice: { number: "F-2026-0001", issueDate: new Date("2026-10-01T09:00:00Z"), totalCents: 180_000, label: "Facture" },
      paidToDateCents: 180_000,
      remainingCents: 0,
      issuedAt: new Date("2026-10-18T09:00:00Z"),
    },
  ],
  [
    "paiement partiel après un avoir, carte (Stripe), montants longs, nom long",
    {
      company,
      client: {
        displayName: "Association des Amis de la Bibliothèque Municipale de Saint-Caprais-de-Bordeaux et des Communes Environnantes",
        addressLine1: "12 rue de l'Exemple, bâtiment B, 3e étage",
        postalCode: "33000",
        city: "Bordeaux",
      },
      payment: { paidAt: new Date("2026-10-13T08:00:00Z"), amountCents: 1_234_567, methodLabel: "carte bancaire", reference: "pi_3QExemple0123456789abcdefABCDEF" },
      invoice: { number: "F-2026-0004", issueDate: new Date("2026-10-01T09:00:00Z"), totalCents: 12_345_678, label: "Facture de solde" },
      creditedCents: 30_000,
      paidToDateCents: 1_234_567,
      remainingCents: 11_081_111,
      issuedAt: new Date("2026-10-18T09:00:00Z"),
    },
  ],
];

describe("reçu de paiement : texte du PDF lisible, sans mot collé ni ligne qui en chevauche une autre", () => {
  it.each(CASES)("%s", async (_name, data) => {
    const buf = Buffer.from(await renderToBuffer(React.createElement(PaymentReceiptDocument, data) as never));
    const { items, lines } = await readPdf(buf);
    const text = lines.join("\n");

    // Aucun mot collé au symbole ou à un montant (défaut « 1 800,00 €en » vu sur la facture).
    expect(text).not.toMatch(/€[\p{L}\d]/u);
    expect(text).not.toMatch(/\d,\d{2}€/);
    // Une seule chaîne par ligne : libellés et phrases entiers sur leur ligne.
    expect(lines).toContain(`le ${data.payment.paidAt.toISOString().slice(8, 10)}/10/2026, par ${data.payment.methodLabel} (réf. ${data.payment.reference})`);
    expect(text).toContain("Réglé à ce jour (ce paiement compris)");
    if (data.creditedCents) expect(text).toMatch(/Avoirs émis sur cette facture -300,00[  ]€/);

    // Aucune ligne de texte ne chevauche la suivante (grand titre ou montant sur la ligne d'après).
    for (const a of items) {
      for (const b of items) {
        if (a === b || Math.abs(a.y - b.y) < 1) continue;
        const sideBySide = a.x < b.x + b.w && b.x < a.x + a.w;
        if (!sideBySide) continue;
        const [upper, lower] = a.y > b.y ? [a, b] : [b, a];
        // Entre deux lignes l'une au-dessus de l'autre : au moins 80 % du corps de la ligne du haut.
        expect(upper.y - lower.y, `« ${upper.str} » chevauche « ${lower.str} »`).toBeGreaterThanOrEqual(upper.h * 0.8);
      }
    }
  });
});
