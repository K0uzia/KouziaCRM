import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { writeSiteText } from "@/lib/site/texts.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// PDF d'un devis en paiement unique avec maintenance en option, compris et non compris (décisions du 28/10/2026).
const { buildApp } = await import("@/app.js");
const { loadDocumentForPdf, pdfDataOfLoaded } = await import("@/lib/pdf/document-pdf.js");
const { readableInvoice, snapshotFor } = await import("@/lib/pdf/readable-documents.js");
const { renderInvoicePdf } = await import("@/lib/pdf/render.js");

const ADMIN = "admin-option-pdf@kouzia.test";
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
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });
const norm = (s: unknown) => JSON.stringify(s).replace(/[  ]/g, " ");

const site = { description: "Création du site vitrine", quantity: 1, unitPriceEuros: 1200 };

async function draftBody() {
  const client = await createClient({ displayName: "Client PDF Option" });
  const svc = await createService({ name: "Maintenance annuelle", unitPriceCents: 30000 });
  return {
    clientId: client.id,
    documentType: "QUOTE",
    billingMode: "ONE_OFF",
    paymentPlanOffer: "TWO",
    lines: [
      site,
      { description: "Maintenance annuelle", quantity: 1, unitPriceEuros: 300, isSubscription: true, isOptional: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc.id, commitmentMonths: 24 },
    ],
  };
}

async function issued() {
  const body = await draftBody();
  const res = await call("POST", "/api/invoices", body);
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  expect((await call("POST", `/api/invoices/${id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  const lineId = (await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: id, isOptional: true } })).id;
  return { id, lineId, body };
}

const readable = async (id: string) => readableInvoice(await pdfDataOfLoaded((await loadDocumentForPdf(id))!), "LIVE").doc;

describe("PDF : option au choix et non compris", () => {
  it("avant signature : option hors du tableau, bloc d'option avec les deux totaux, liste « Non compris »", async () => {
    const { id } = await issued();
    const doc = await readable(id);
    expect(doc.table?.rows.map((r) => r.cells[0])).toEqual(["Création du site vitrine"]);
    const option = doc.sections.find((s) => s.heading === "Option au choix à la signature");
    expect(norm(option)).toContain("Maintenance annuelle, 300,00 € par an, engagement 24 mois à partir de la livraison.");
    expect(norm(option)).toContain("Total sans l'option : 1 200,00 €");
    expect(norm(option)).toContain("Avec l'option : 1 200,00 € + 300,00 € par an (soit 600,00 € sur 24 mois)");
    const excluded = doc.sections.find((s) => s.heading === "Non compris");
    expect(excluded?.items.length).toBe(4);
    expect(norm(doc.totals)).toContain("1 200,00 €");
  });

  it("le texte du PDF est exactement celui de la version lisible", async () => {
    const { id } = await issued();
    const data = await pdfDataOfLoaded((await loadDocumentForPdf(id))!);
    const { ok } = await snapshotFor(await renderInvoicePdf(data), readableInvoice(data, "ARCHIVE"));
    expect(ok).toBe(true);
  });

  it("après signature : « Option retenue » (ligne dans le tableau, engagement depuis la livraison) ou « Option non retenue »", async () => {
    const kept = await issued();
    expect((await call("POST", `/api/quotes/${kept.id}/sign-offline`, { signerName: "Léa Martin", optionalLines: [{ id: kept.lineId, accepted: true }] })).statusCode).toBe(200);
    const keptDoc = await readable(kept.id);
    expect(norm(keptDoc.sections)).toContain("Option retenue : Maintenance annuelle, 300,00 € par an, engagement 24 mois à partir de la livraison.");
    expect(keptDoc.table?.rows.map((r) => r.cells[0])).toEqual(["Création du site vitrine", "Maintenance annuelle"]);
    expect(norm(keptDoc.sections)).toContain("Engagement de 24 mois à compter de la livraison.");
    expect(norm(keptDoc.sections)).not.toContain("Total sans l'option");

    const declined = await issued();
    expect((await call("POST", `/api/quotes/${declined.id}/sign-offline`, { signerName: "Léa Martin", optionalLines: [{ id: declined.lineId, accepted: false }] })).statusCode).toBe(200);
    const declinedDoc = await readable(declined.id);
    expect(norm(declinedDoc.sections)).toContain("Option non retenue : Maintenance annuelle.");
    expect(declinedDoc.table?.rows.map((r) => r.cells[0])).toEqual(["Création du site vitrine"]);
  });

  it("propositions : « Compris dans l'abonnement » sous la formule abonnement, titres sans doublon", async () => {
    await writeSiteText("offres", {
      formules: { site: { titre: "Site", items: ["Création du site", "Hébergement et nom de domaine"] }, logiciel: { titre: "Logiciel", items: ["Maintenance"] } },
      tarif: "Sur devis",
    });
    const client = await createClient({ displayName: "Client Formules PDF" });
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    const q = (
      await call("POST", "/api/invoices", {
        clientId: client.id,
        documentType: "QUOTE",
        options: [
          { label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "TWO", lines: [site] },
          {
            label: "Proposition B",
            billingMode: "RECURRING",
            lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc.id, commitmentMonths: 36 }],
          },
        ],
      })
    ).json();
    expect((await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
    const doc = await readable(q.id);
    expect(doc.proposals?.map((p) => p.heading)).toEqual(["Proposition A : Paiement unique", "Proposition B"]);
    expect(doc.proposals![0]!.sections.find((s) => s.heading === "Non compris")?.items.length).toBe(4);
    expect(doc.proposals![1]!.sections.find((s) => s.heading === "Compris dans l'abonnement")?.items).toEqual(["Création du site", "Hébergement et nom de domaine"]);
  });

  it("aperçu du brouillon : rendu avec l'option", async () => {
    const preview = await call("POST", "/api/invoices/preview.pdf", await draftBody());
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers["content-type"]).toContain("application/pdf");
  });
});
