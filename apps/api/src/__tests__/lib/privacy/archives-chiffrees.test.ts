import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { encrypt } from "@/lib/crypto.js";
import { issuedPdfAbsolutePath } from "@/lib/pdf/issued-archive.js";
import { paymentReceiptPdf } from "@/lib/pdf/receipt-archive.js";
import { signDocumentToken } from "@/lib/documents/public-token.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Demande du 27/10/2026 (« copie client des factures », approuvée par Alexandre) : la version lisible (readableSnapshot)
// et les PDF archivés reprenaient en clair les coordonnées du client. Ils sont chiffrés au repos ; les anciennes archives
// sont recopiées chiffrées par le worker ; PDF servi et empreinte SHA-256 inchangés.
const { buildApp } = await import("@/app.js");
const { backfillEncryptedArchives } = await import("@/lib/privacy/at-rest.js");

const ADMIN = "admin-archives@kouzia.test";
const EMAIL = "lea.archives@exemple.fr";
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
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function issuedInvoice() {
  const client = await createClient({ displayName: "Léa Archives", type: "B2B" });
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt(EMAIL) } });
  const inv = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "INVOICE", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 500 }] })).json();
  expect((await call("POST", `/api/invoices/${inv.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  return prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
}

describe("archives chiffrées au repos", () => {
  it("facture émise : fichier PDF et version lisible chiffrés ; PDF servi et version lisible identiques", async () => {
    const inv = await issuedInvoice();
    const onDisk = await fs.readFile(issuedPdfAbsolutePath(inv.pdfPath!));
    expect(onDisk.subarray(0, 4).toString()).not.toBe("%PDF");
    expect(inv.readableSnapshot!.startsWith("enc1:")).toBe(true);
    expect(inv.readableSnapshot).not.toContain(EMAIL);
    const served = (await call("GET", `/api/invoices/${inv.id}/pdf`)).rawPayload;
    expect(served.subarray(0, 4).toString()).toBe("%PDF");
    expect(sha(served)).toBe(inv.pdfSha256);
    const readable = await app.inject({ method: "GET", url: `/api/public/documents/${signDocumentToken(inv.id)}/lisible` });
    expect(readable.statusCode).toBe(200);
    expect(readable.json()).toMatchObject({ kind: "INVOICE", source: "ARCHIVE" });
  });

  it("reçu de paiement : fichier et version lisible chiffrés", async () => {
    const inv = await issuedInvoice();
    const payment = await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 50000, paidAt: new Date(), method: "BANK_TRANSFER" } });
    const pdf = await paymentReceiptPdf(payment.id);
    expect(pdf!.subarray(0, 4).toString()).toBe("%PDF");
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect((await fs.readFile(issuedPdfAbsolutePath(row.receiptPdfPath!))).subarray(0, 4).toString()).not.toBe("%PDF");
    expect(row.receiptReadableSnapshot!.startsWith("enc1:")).toBe(true);
  });

  it("archive ancienne en clair : recopiée chiffrée par le worker, PDF servi inchangé, idempotent", async () => {
    const inv = await issuedInvoice();
    const served = (await call("GET", `/api/invoices/${inv.id}/pdf`)).rawPayload;
    // État d'avant le chiffrement : fichier et version lisible en clair.
    await fs.writeFile(issuedPdfAbsolutePath(inv.pdfPath!), served);
    const { openReadable } = await import("@/lib/pdf/archive-file.js");
    await prisma.invoice.update({ where: { id: inv.id }, data: { readableSnapshot: openReadable(inv.readableSnapshot!) } });

    const done = await backfillEncryptedArchives();
    expect(done.archives).toBeGreaterThanOrEqual(1);
    expect(done.readables).toBeGreaterThanOrEqual(1);
    expect((await fs.readFile(issuedPdfAbsolutePath(inv.pdfPath!))).subarray(0, 4).toString()).not.toBe("%PDF");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).readableSnapshot!.startsWith("enc1:")).toBe(true);
    expect(sha((await call("GET", `/api/invoices/${inv.id}/pdf`)).rawPayload)).toBe(inv.pdfSha256);
    expect(await backfillEncryptedArchives()).toEqual({ archives: 0, readables: 0 });
  });
});
