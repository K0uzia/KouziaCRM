import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";
import { pdfText } from "../helpers/pdf-text.js";

// PDF d'un devis à rythme au choix (retour d'Alexandre du 29/10/2026) : le tableau des rythmes remplace l'encadré
// « Abonnement X / an », avec la remise par rythme ; la ligne de remise revient dans le tableau des lignes.
const { buildApp } = await import("@/app.js");
const { loadDocumentForPdf, pdfDataOfLoaded } = await import("@/lib/pdf/document-pdf.js");
const { readableInvoice, snapshotFor } = await import("@/lib/pdf/readable-documents.js");
const { renderInvoicePdf } = await import("@/lib/pdf/render.js");

const ADMIN = "admin-rythme-pdf@kouzia.test";
let app: FastifyInstance;
let cookie: string;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  // Production : 1 mois offert sur l'annuel.
  await prisma.companySettings.updateMany({ data: { annualFreeMonths: 1 } });
  invalidateCompanySettingsCache();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

async function issuedQuote(body: Record<string, unknown> = {}, lineExtra: Record<string, unknown> = {}) {
  const client = await createClient({ displayName: "Atelier Rythme", type: "B2B" });
  const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
  const res = await call("POST", "/api/invoices", {
    clientId: client.id,
    documentType: "QUOTE",
    billingMode: "RECURRING",
    offeredIntervals: ["YEAR", "QUARTER", "MONTH"],
    lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc.id, commitmentMonths: 12, ...lineExtra }],
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  const issued = await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } });
  expect(issued.statusCode, issued.body).toBe(200);
  return { id };
}

describe("PDF : tableau des rythmes à la place de l'encadré Abonnement (29/10/2026)", () => {
  it("colonnes rythme, prix, 12 premiers mois remisés, total ; ligne de remise « selon le rythme » ; texte du PDF = version lisible", async () => {
    const { id } = await issuedQuote({ openingDiscount: true }, { commitmentMonths: 36 });
    const data = await pdfDataOfLoaded((await loadDocumentForPdf(id))!);
    const { doc } = readableInvoice(data, "LIVE");
    const n = (v: unknown) => JSON.stringify(v).replace(/[  ]/g, " ");
    // Ligne de remise dans le tableau des lignes, montant selon le rythme.
    expect(doc.table?.rows.map((r) => r.cells)).toContainEqual(["Remise d’ouverture : 30 % sur les 12 premiers mois", "", "", "selon le rythme"]);
    // Plus d'encadré « Abonnement X / an » : le tableau des rythmes le remplace.
    expect(n(doc.totals)).not.toContain("1 500,00 € / an");
    const table = doc.sections.find((s) => s.heading === "Rythme de paiement au choix")!;
    expect(n(table)).toContain("12 PREMIERS MOIS (REMISE 30 %)");
    expect(table.items.map((i) => i.replace(/[  ]/g, " "))).toEqual([
      "Annuel, 1 500,00 € / an, 1 050,00 €, 4 050,00 € (3 échéances)",
      "Trimestriel, 409,09 € / trimestre, 286,36 € / trimestre, 4 418,16 € (12 échéances)",
      "Mensuel, 136,36 € / mois, 95,45 € / mois, 4 418,04 € (36 échéances)",
    ]);
    expect(n(table)).toContain("Départ de la facturation");
    const { ok } = await snapshotFor(await renderInvoicePdf(data), readableInvoice(data, "ARCHIVE"));
    expect(ok).toBe(true);
  });

  it("version des CGV en date française, sans trait d'union de coupure", async () => {
    await prisma.companySettings.updateMany({ data: { cgvPublished: true, cgvUrl: "https://kouzia.com/cgv", cgvVersion: "2026-10-28" } });
    invalidateCompanySettingsCache();
    const { id } = await issuedQuote();
    const data = await pdfDataOfLoaded((await loadDocumentForPdf(id))!);
    const text = pdfText(await renderInvoicePdf(data)).replace(/\s+/g, " ");
    expect(text).toContain("Conditions générales de vente applicables (version du 28/10/2026) : https://kouzia.com/cgv");
    expect(text).not.toContain("2026-10-28");
  });
});
