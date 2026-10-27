import { openReadable, readArchiveFile } from "@/lib/pdf/archive-file.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const alertAdmin = vi.fn(async () => undefined);
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));

const { buildApp } = await import("@/app.js");
const { signDocumentToken, signReceiptToken } = await import("@/lib/documents/public-token.js");
const { issuedPdfAbsolutePath } = await import("@/lib/pdf/issued-archive.js");
const { backfillReadableSnapshots } = await import("@/lib/pdf/readable-documents.js");
const { openPortalSession, PORTAL_COOKIE } = await import("@/lib/portal/auth.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  alertAdmin.mockClear();
});

let ip = 0;
const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers, remoteAddress: `10.9.${Math.floor(++ip / 250)}.${ip % 250}` });

async function invoiceOf(documentType: InvoiceDocumentType, number: string, clientId?: string) {
  const id = clientId ?? (await createClient({ type: "B2C", displayName: "Lou Martin" })).id;
  return prisma.invoice.create({
    data: {
      documentType,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      number,
      clientId: id,
      subtotalCents: 30_000,
      totalCents: 30_000,
      issueDate: new Date(2026, 9, 1),
      ...(documentType === InvoiceDocumentType.QUOTE ? { quoteStatus: "SENT" } : {}),
      lines: { create: [{ position: 0, description: "Site vitrine", quantity: 1, unitPriceCents: 30_000, lineTotalCents: 30_000 }] },
    },
  });
}

const CONTRACT_KEYS = ["version", "kind", "title", "number", "issuer", "recipient", "details", "table", "totals", "sections", "footer", "source"];

function expectReadableHeaders(res: Awaited<ReturnType<typeof get>>) {
  expect(res.headers["content-language"]).toBe("fr");
  expect(res.headers["cache-control"]).toBe("private, no-store");
  expect(res.headers["x-robots-tag"]).toContain("noindex");
  expect(res.headers["referrer-policy"]).toBe("no-referrer");
}

describe("GET /api/public/documents/:token/lisible (contrat B)", () => {
  it("facture : JSON figé à l'archivage, même contenu que le PDF archivé, en-têtes du contrat", async () => {
    const inv = await invoiceOf(InvoiceDocumentType.INVOICE, "F-2026-0960");
    const res = await get(`/api/public/documents/${signDocumentToken(inv.id)}/lisible`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expectReadableHeaders(res);
    const doc = res.json() as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(CONTRACT_KEYS);
    expect(doc).toMatchObject({ version: 1, kind: "INVOICE", title: "Facture F-2026-0960", number: "F-2026-0960", source: "ARCHIVE" });
    // Le premier accès a archivé le PDF et figé la version lisible avec lui.
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(row.pdfPath).not.toBeNull();
    expect(JSON.parse(openReadable(row.readableSnapshot!))).toEqual(doc);
    // Figée : un réglage modifié ensuite ne la change pas, comme le PDF archivé.
    await prisma.companySettings.updateMany({ data: { city: "Brest" } });
    (await import("@/lib/company.js")).invalidateCompanySettingsCache();
    expect((await get(`/api/public/documents/${signDocumentToken(inv.id)}/lisible`)).json()).toEqual(doc);
  }, 30_000);

  it("devis émis non signé : rendu à la demande (LIVE), comme convenu avec le site (27/10/2026)", async () => {
    const quote = await invoiceOf(InvoiceDocumentType.QUOTE, "D-2026-0960");
    const res = await get(`/api/public/documents/${signDocumentToken(quote.id)}/lisible`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "QUOTE", title: "Devis D-2026-0960", source: "LIVE" });
  }, 30_000);

  it("404 identique : jeton invalide, jeton de reçu, brouillon, version indisponible", async () => {
    const inv = await invoiceOf(InvoiceDocumentType.INVOICE, "F-2026-0961");
    const draft = await prisma.invoice.create({
      data: { documentType: InvoiceDocumentType.INVOICE, status: InvoiceStatus.DRAFT, clientId: inv.clientId, subtotalCents: 0, totalCents: 0 },
    });
    const payment = await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 1_000, paidAt: new Date(2026, 9, 2), method: PaymentMethod.CARD } });
    await prisma.invoice.update({ where: { id: inv.id }, data: { pdfPath: "issued-documents/absent.pdf", readableSnapshot: '{"unavailable":"text-mismatch"}' } });
    const responses = await Promise.all([
      get("/api/public/documents/abc.def/lisible"),
      get(`/api/public/documents/${signReceiptToken(payment.id)}/lisible`),
      get(`/api/public/documents/${signDocumentToken(draft.id)}/lisible`),
      get(`/api/public/documents/${signDocumentToken(inv.id)}/lisible`),
      get(`/api/public/documents/${signDocumentToken(inv.id, -60)}/lisible`),
    ]);
    for (const r of responses) {
      expect(r.statusCode).toBe(404);
      expect(r.json()).toEqual({ error: "Document introuvable" });
      expectReadableHeaders(r);
    }
  }, 30_000);
});

describe("GET /api/public/receipts/:token/lisible (contrat B)", () => {
  it("reçu : archivé au premier accès, version lisible figée ; jeton de document : 404 identique", async () => {
    const inv = await invoiceOf(InvoiceDocumentType.INVOICE, "F-2026-0962");
    const payment = await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 10_000, paidAt: new Date(2026, 9, 2), method: PaymentMethod.CARD } });
    const res = await get(`/api/public/receipts/${signReceiptToken(payment.id)}/lisible`);
    expect(res.statusCode, res.body).toBe(200);
    expectReadableHeaders(res);
    expect(res.json()).toMatchObject({ kind: "PAYMENT_RECEIPT", title: "Reçu de paiement F-2026-0962", source: "ARCHIVE" });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).receiptReadableSnapshot).not.toBeNull();
    const wrong = await get(`/api/public/receipts/${signDocumentToken(inv.id)}/lisible`);
    expect(wrong.statusCode).toBe(404);
    expect(wrong.json()).toEqual({ error: "Document introuvable" });
  }, 30_000);
});

describe("/api/public/tracking : readableAvailable et receiptReadableAvailable (ajouts)", () => {
  it("présents seulement quand la version lisible existe", async () => {
    const client = await createClient({ type: "B2C", displayName: "Lou Martin" });
    const quote = await invoiceOf(InvoiceDocumentType.QUOTE, "D-2026-0963", client.id);
    const archived = await invoiceOf(InvoiceDocumentType.INVOICE, "F-2026-0963", client.id);
    const notYet = await invoiceOf(InvoiceDocumentType.INVOICE, "F-2026-0964", client.id);
    const paid = await prisma.payment.create({ data: { invoiceId: archived.id, amountCents: 10_000, paidAt: new Date(2026, 9, 2), method: PaymentMethod.CARD } });
    await get(`/api/public/documents/${signDocumentToken(archived.id)}/lisible`);
    await get(`/api/public/receipts/${signReceiptToken(paid.id)}/lisible`);

    const { token } = await openPortalSession({ clientId: client.id, deviceId: "appareil-lisible", ipAddress: "203.0.113.9", userAgent: "Test" });
    const res = await get("/api/public/tracking", { cookie: `${PORTAL_COOKIE}=${token}` });
    expect(res.statusCode, res.body).toBe(200);
    const t = res.json() as { documents: Array<Record<string, unknown>>; paymentHistory: { items: Array<Record<string, unknown>> } };
    const byNumber = (n: string) => t.documents.find((d) => d.number === n)!;
    expect(byNumber(quote.number!).readableAvailable).toBe(true);
    expect(byNumber(archived.number!).readableAvailable).toBe(true);
    expect("readableAvailable" in byNumber(notYet.number!)).toBe(false);
    const entry = t.paymentHistory.items.find((i) => i.id === `payment-${paid.id}`)!;
    expect(entry.receiptReadableAvailable).toBe(true);
  }, 60_000);
});

describe("rattrapage des documents archivés avant la version lisible (QB1 a)", () => {
  async function archivedWithoutReadable(number: string) {
    const inv = await invoiceOf(InvoiceDocumentType.INVOICE, number);
    const { issuedDocumentPdf } = await import("@/lib/pdf/issued-archive.js");
    await issuedDocumentPdf(inv.id);
    await prisma.invoice.update({ where: { id: inv.id }, data: { readableSnapshot: null } });
    return inv;
  }

  it("texte identique au PDF archivé : figée ; règlement enregistré après l'archivage exclu", async () => {
    const inv = await archivedWithoutReadable("F-2026-0970");
    const archivedAt = (await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).pdfArchivedAt!;
    await prisma.payment.create({
      data: { invoiceId: inv.id, amountCents: 30_000, paidAt: new Date(2026, 9, 3), method: PaymentMethod.CARD, createdAt: new Date(archivedAt.getTime() + 60_000) },
    });
    expect(await backfillReadableSnapshots()).toEqual({ frozen: 1, unavailable: 0 });
    const doc = JSON.parse(openReadable((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).readableSnapshot!));
    expect(doc).toMatchObject({ version: 1, number: "F-2026-0970" });
    expect(JSON.stringify(doc)).not.toContain("Règlements reçus");
    expect(alertAdmin).not.toHaveBeenCalled();
  }, 30_000);

  it("texte différent (réglage changé depuis) : indisponible, lien masqué, une seule alerte", async () => {
    const inv = await archivedWithoutReadable("F-2026-0971");
    await prisma.companySettings.updateMany({ data: { city: "Brest" } });
    (await import("@/lib/company.js")).invalidateCompanySettingsCache();
    expect(await backfillReadableSnapshots()).toEqual({ frozen: 0, unavailable: 1 });
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(JSON.parse(row.readableSnapshot!)).toEqual({ unavailable: "text-mismatch" });
    expect(alertAdmin).toHaveBeenCalledTimes(1);
    expect(String((alertAdmin.mock.calls[0] as unknown[])[1])).toContain("F-2026-0971");
    // Le PDF archivé reste intact et servi ; la version lisible répond 404.
    expect(await fs.readFile(issuedPdfAbsolutePath(row.pdfPath!))).toBeTruthy();
    expect((await get(`/api/public/documents/${signDocumentToken(inv.id)}/lisible`)).statusCode).toBe(404);
    // Déjà traité : pas de nouvelle alerte au passage suivant.
    expect(await backfillReadableSnapshots()).toEqual({ frozen: 0, unavailable: 0 });
    expect(alertAdmin).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe("devis signé : le document signé, jamais un nouveau rendu (décision du 25/10/2026)", () => {
  async function signedQuote(number: string) {
    const client = await createClient({ type: "B2C", displayName: "Lou Martin" });
    const quote = await invoiceOf(InvoiceDocumentType.QUOTE, number, client.id);
    await prisma.invoice.update({ where: { id: quote.id }, data: { quoteStatus: "ACCEPTED" } });
    const audit = await prisma.quoteAcceptanceAudit.create({ data: { quoteId: quote.id, signerName: "Lou Martin", source: "PORTAL" } });
    const { recordQuoteAcceptanceProof, signedQuoteAbsolutePath } = await import("@/lib/invoices/acceptance-proof.js");
    await recordQuoteAcceptanceProof(audit.id, quote.id, { sendConfirmation: false });
    const { pdfPath } = await prisma.quoteAcceptanceAudit.findUniqueOrThrow({ where: { id: audit.id } });
    return { quote, client, archive: await readArchiveFile(signedQuoteAbsolutePath(pdfPath!)) };
  }
  const changeCity = async () => {
    await prisma.companySettings.updateMany({ data: { city: "Brest" } });
    (await import("@/lib/company.js")).invalidateCompanySettingsCache();
  };

  it("PDF : l'archive de la preuve, même après un réglage changé ; version lisible figée au 1er accès", async () => {
    const { quote, archive } = await signedQuote("D-2026-0980");
    const readable = await get(`/api/public/documents/${signDocumentToken(quote.id)}/lisible`);
    expect(readable.statusCode, readable.body).toBe(200);
    expect(readable.json()).toMatchObject({ kind: "QUOTE", number: "D-2026-0980", source: "ARCHIVE" });
    await changeCity();
    const pdf = await get(`/api/public/documents/${signDocumentToken(quote.id)}`);
    expect(pdf.statusCode).toBe(200);
    expect(Buffer.compare(pdf.rawPayload, archive)).toBe(0);
    expect((await get(`/api/public/documents/${signDocumentToken(quote.id)}/lisible`)).json()).toEqual(readable.json());
  }, 60_000);

  it("version lisible figée à la signature (P0 du 25/10/2026) : servie même après un réglage changé", async () => {
    const { quote } = await signedQuote("D-2026-0982");
    await changeCity();
    const readable = await get(`/api/public/documents/${signDocumentToken(quote.id)}/lisible`);
    expect(readable.statusCode, readable.body).toBe(200);
    expect(readable.json()).toMatchObject({ number: "D-2026-0982", source: "ARCHIVE" });
  }, 60_000);

  it("devis signé sans version figée (antérieur) et rendu du jour différent du PDF signé : indisponible et plus annoncée", async () => {
    const { quote, client } = await signedQuote("D-2026-0981");
    await prisma.invoice.update({ where: { id: quote.id }, data: { readableSnapshot: null } });
    await changeCity();
    expect((await get(`/api/public/documents/${signDocumentToken(quote.id)}/lisible`)).statusCode).toBe(404);
    const { token } = await openPortalSession({ clientId: client.id, deviceId: "appareil-signe", ipAddress: "203.0.113.9", userAgent: "Test" });
    const t = (await get("/api/public/tracking", { cookie: `${PORTAL_COOKIE}=${token}` })).json() as { documents: Array<Record<string, unknown>> };
    expect("readableAvailable" in t.documents.find((d) => d.number === "D-2026-0981")!).toBe(false);
  }, 60_000);
});
