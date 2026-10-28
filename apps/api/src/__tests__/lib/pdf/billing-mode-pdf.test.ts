import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";
import { issueQuote } from "@/lib/invoices/transitions.js";
import { renderDocumentPdf } from "@/lib/pdf/document-pdf.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

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

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await ensureDefaultLegalClauses();
  invalidateCompanySettingsCache();
});
afterEach(async () => {
  await resetDb();
});

async function quote(billingMode: "ONE_OFF" | "RECURRING", offer: string, lines: Array<Record<string, unknown>>) {
  const client = await createClient({ displayName: "Atelier PDF" });
  const total = lines.reduce((s, l) => s + (l.unitPriceCents as number), 0);
  const q = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: total,
      totalCents: total,
      paymentPlanOffer: offer,
      billingMode,
      lines: { create: lines.map((l, i) => ({ position: i + 1, quantity: 1, lineTotalCents: l.unitPriceCents as number, ...l })) as never },
    },
  });
  await issueQuote(q.id);
  return pdfText((await renderDocumentPdf(q.id))!);
}

describe("PDF du devis selon le mode de facturation", () => {
  it("paiement unique en 3 fois : échéances à parts égales, datées depuis la signature", async () => {
    const text = await quote("ONE_OFF", "THREE", [{ description: "Site vitrine", unitPriceCents: 100000 }]);
    // Pourcentages à deux décimales (audit du 28/10/2026).
    expect(text).toMatch(/1re échéance \(33,33\s%\)/);
    expect(text).toContain("333,33 €");
    expect(text).toContain("30 jours après la signature");
    expect(text).toMatch(/3e échéance \(33,34\s%\)/);
    expect(text).not.toContain("Acompte");
  });

  it("récurrent trimestriel livré : abonnement par trimestre, engagement et clause d'engagement, aucun frais", async () => {
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    const sub = { isSubscription: true, billingInterval: "QUARTER", billingDay: 1, commitmentMonths: 36, subscriptionStart: "DELIVERY", serviceId: svc.id };
    const text = await quote("RECURRING", "ONE", [{ description: "Site tout compris", unitPriceCents: 37500, ...sub }]);
    expect(text).not.toContain("mise en service");
    // Départ « à la livraison » : le même partout (ligne, récapitulatif, encadré d'abonnement).
    expect(text).not.toContain("à partir de la signature");
    expect(text).toContain("375,00 € / trimestre");
    // Sous le total, une phrase par information ; ni la ligne ni l'encadré ne les répètent (demande du 25/10/2026).
    const once = (s: string) => expect(text.split(s).length - 1, s).toBe(1);
    once("Facturé chaque trimestre le 1.");
    once("Départ de la facturation : à partir de la livraison du projet.");
    once("Engagement de 36 mois à compter de la signature.");
    once("Total sur la durée de l'engagement : 4 500,00 € (12 échéances).");
    once("Soit 125,00 € par mois, à titre indicatif.");
    expect(text).not.toContain("Abonnement trimestriel, facturé chaque trimestre");
    expect(text).not.toContain("facturés automatiquement");
    expect(text).not.toContain("Facturation :");
    // Encadré : le titre puis la clause d'engagement seule, sans redire la désignation.
    expect(text).toMatch(/Abonnement avec engagement \[BROUILLON[^\]]*\] Abonnement conclu pour la durée d'engagement/);
    once("Site tout compris");
    expect(text).not.toContain("Total du projet");
    expect(text).not.toContain("hors acompte et échéancier");
  });

  it("récurrent trimestriel engagé, proposition activée : {{periodicite}} et {{periode}} remplies, aucune clause « résiliable à tout moment »", async () => {
    await prisma.legalClause.updateMany({ where: { title: "Abonnement avec engagement" }, data: { active: false } });
    await prisma.legalClause.updateMany({ where: { title: { startsWith: "Abonnement avec engagement (proposition" } }, data: { active: true } });
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    const text = await quote("RECURRING", "ONE", [
      { description: "Site tout compris", unitPriceCents: 37500, isSubscription: true, billingInterval: "QUARTER", billingDay: 1, commitmentMonths: 12, serviceId: svc.id },
    ]);
    expect(text).toContain("payable d'avance chaque trimestre, par échéances d'un trimestre");
    expect(text).not.toMatch(/\{\{/);
    expect(text).not.toContain("résiliable à tout moment");
    expect(text).not.toContain("Sans durée minimale");
  });

  it("récurrent annuel 12 mois avec 1 mois offert : singulier (« 1 échéance », « 1 mois offert, compté »)", async () => {
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    const text = await quote("RECURRING", "ONE", [
      { description: "Site tout compris", unitPriceCents: 150000, isSubscription: true, billingInterval: "YEAR", billingDay: 1, commitmentMonths: 12, subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 1, serviceId: svc.id },
    ]);
    expect(text).toContain("Total sur la durée de l'engagement : 1 500,00 € (1 échéance).");
    expect(text).toContain("Départ de la facturation : après 1 mois offert, compté à partir de la signature.");
    expect(text).not.toMatch(/1 échéances|1 mois offerts|compté s/);
  });
  it("récurrent sans engagement : refusé à l'émission (brouillon antérieur à la règle)", async () => {
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    await expect(
      quote("RECURRING", "ONE", [
        { description: "Site tout compris", unitPriceCents: 37500, isSubscription: true, billingInterval: "QUARTER", billingDay: 1, serviceId: svc.id },
      ]),
    ).rejects.toThrow(/12, 24 ou 36 mois/);
  });
});
