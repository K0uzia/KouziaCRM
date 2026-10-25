import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Devis à 2 propositions (P2, 25/10/2026) : PDF et version lisible (contrat proposals validé avec le site).
const { buildApp } = await import("@/app.js");
const { loadDocumentForPdf, pdfDataOfLoaded } = await import("@/lib/pdf/document-pdf.js");
const { readableInvoice, snapshotFor } = await import("@/lib/pdf/readable-documents.js");
const { renderInvoicePdf } = await import("@/lib/pdf/render.js");

const ADMIN = "admin-propositions-pdf@kouzia.test";
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

async function quoteWithOptions() {
  const client = await createClient({ displayName: "Client Formules" });
  const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
  const body = {
    clientId: client.id,
    documentType: "QUOTE",
    notes: "Deux formules au choix",
    options: [
      { label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "TWO", lines: [{ description: "Création du site vitrine", quantity: 1, unitPriceEuros: 2400 }] },
      {
        label: "Abonnement 3 ans",
        billingMode: "RECURRING",
        openingDiscount: true,
        lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc.id, commitmentMonths: 36 }],
      },
    ],
  };
  const res = await call("POST", "/api/invoices", body);
  expect(res.statusCode, res.body).toBe(201);
  return { quote: res.json(), body };
}

/** Émission simulée (lot P3) : le PDF d'un devis se lit dès qu'il a un numéro. */
const markIssued = (id: string, extra: Record<string, unknown> = {}) =>
  prisma.invoice.update({ where: { id }, data: { number: "D-2026-0042", status: "ISSUED", quoteStatus: "SENT", issueDate: new Date("2026-10-25T10:00:00Z"), ...extra } });

const norm = (s: unknown) => JSON.stringify(s).replace(/[  ]/g, " ");

describe("devis à 2 propositions : PDF et version lisible (P2)", () => {
  it("version lisible : introduction, une entrée par proposition (tableau, totaux, sections), commun au niveau du document", async () => {
    const { quote } = await quoteWithOptions();
    await markIssued(quote.id);
    const data = await pdfDataOfLoaded((await loadDocumentForPdf(quote.id))!);
    const { doc } = readableInvoice(data, "LIVE");

    expect(doc.table).toBeNull();
    expect(doc.totals).toEqual([]);
    // Ordre du PDF : conditions (à côté du destinataire), puis l'introduction, avant les propositions.
    expect(doc.sections.slice(0, 2)).toEqual([
      { heading: "Conditions", paragraphs: ["Devis valable 30 jours"], items: [] },
      { heading: null, paragraphs: ["Ce devis propose 2 formules : choisissez-en une à la signature."], items: [] },
    ]);
    expect(doc.proposals?.map((p) => p.heading)).toEqual(["Proposition A : Paiement unique", "Proposition B : Abonnement 3 ans"]);

    const [a, b] = doc.proposals!;
    expect(a!.table!.rows.map((r) => r.cells[0])).toEqual(["Création du site vitrine"]);
    expect(norm(a!.totals)).toContain("2 400,00 €");
    // Échéancier de la proposition A dans ses sections, pas au niveau du document.
    expect(a!.sections.some((s) => /chéancier/.test(s.heading ?? ""))).toBe(true);
    expect(b!.table!.rows.map((r) => r.cells[0])[0]).toBe("Site tout compris");
    expect(norm(b!.totals)).toContain("Abonnement");
    expect(norm(b!)).toContain("Remise d’ouverture");
    expect(norm(doc.sections)).not.toContain("chéancier");
    // Commun : notes une seule fois, au niveau du document.
    expect(doc.sections.filter((s) => s.heading === "Notes")).toHaveLength(1);
    expect(norm(doc.proposals)).not.toContain("Deux formules au choix");
  });

  it("le texte du PDF est exactement celui de la version lisible", async () => {
    const { quote } = await quoteWithOptions();
    await markIssued(quote.id);
    const data = await pdfDataOfLoaded((await loadDocumentForPdf(quote.id))!);
    const built = readableInvoice(data, "ARCHIVE");
    const { ok, snapshot } = await snapshotFor(await renderInvoicePdf(data), built);
    expect(ok).toBe(true);
    // Contrat du site : proposalsAt obligatoire avec proposals ; sections imprimées avant les propositions.
    const frozen = JSON.parse(snapshot);
    expect(frozen.proposalsAt).toBe(2);
    expect(frozen.sections.slice(0, frozen.proposalsAt).map((s: { heading: string | null }) => s.heading)).toEqual(["Conditions", null]);
    expect(frozen.sections[frozen.proposalsAt].heading).toBe("Notes");
  });

  it("devis signé : proposition retenue dans les détails, l'autre marquée non retenue", async () => {
    const { quote } = await quoteWithOptions();
    await markIssued(quote.id, { quoteStatus: "ACCEPTED", quoteSignerName: "Léa Martin", quoteDecidedAt: new Date("2026-10-26T09:00:00Z"), selectedOptionId: quote.options[0].id });
    const { doc } = readableInvoice(await pdfDataOfLoaded((await loadDocumentForPdf(quote.id))!), "LIVE");
    expect(doc.details).toContainEqual({ label: "Proposition retenue", value: "A : Paiement unique" });
    expect(doc.proposals?.map((p) => p.heading)).toEqual(["Proposition A : Paiement unique", "Proposition B : Abonnement 3 ans (non retenue)"]);
  });

  it("aperçu du brouillon : PDF rendu avec ses propositions ; devis simple inchangé (pas de proposals)", async () => {
    const { body } = await quoteWithOptions();
    const preview = await call("POST", "/api/invoices/preview.pdf", body);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.headers["content-type"]).toContain("application/pdf");

    const simple = await call("POST", "/api/invoices", { clientId: body.clientId, documentType: "QUOTE", billingMode: "ONE_OFF", lines: body.options[0]!.lines });
    await markIssued(simple.json().id, { number: "D-2026-0043" });
    const { doc } = readableInvoice(await pdfDataOfLoaded((await loadDocumentForPdf(simple.json().id))!), "LIVE");
    expect(doc.proposals).toBeUndefined();
    expect(doc.proposalsAt).toBeUndefined();
    expect(doc.table?.rows.map((r) => r.cells[0])).toEqual(["Création du site vitrine"]);
  });
});
