import { openReadable, readArchiveFile } from "@/lib/pdf/archive-file.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));
const alertAdmin = vi.fn(async (_subject: string, _text: string) => undefined);
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));

const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { issueInvoice } = await import("@/lib/invoices/transitions.js");
const { sendDocumentPdf } = await import("@/lib/email/send-document-pdf.js");
const { issuedDocumentPdf, issuedPdfAbsolutePath, archivePendingIssuedPdfs } = await import(
  "@/lib/pdf/issued-archive.js"
);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  vi.mocked(mailEnqueue).mockClear();
  alertAdmin.mockClear();
});
afterEach(async () => {
  await resetDb();
});

async function draftInvoice(type: "B2B" | "B2C" = "B2C") {
  const client = await createClient({ type, displayName: "Lou Martin" });
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt("lou@example.test") } });
  return prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: 50_000,
      totalCents: 50_000,
      lines: { create: { position: 1, description: "Site vitrine", quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000 } },
    },
  });
}

describe("PDF archivé des factures et avoirs émis", () => {
  it("archivé à l'émission, servi tel quel même après un changement de réglage ou de clause", async () => {
    const draft = await draftInvoice();
    await issueInvoice(draft.id, new Date(2026, 9, 1));
    const issued = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(issued.pdfPath).toMatch(/^issued-documents\/F-/);
    const onDisk = await readArchiveFile(issuedPdfAbsolutePath(issued.pdfPath!));
    expect(sha(onDisk)).toBe(issued.pdfSha256);

    await prisma.legalClause.updateMany({ data: { body: "Texte modifié après émission" } });
    await prisma.companySettings.updateMany({ data: { pdfFooterText: "Pied modifié après émission" } });
    invalidateCompanySettingsCache();
    const served = await issuedDocumentPdf(draft.id);
    expect(sha(served!)).toBe(issued.pdfSha256);
  });

  it("l'e-mail joint le PDF archivé, pas un nouveau rendu", async () => {
    const draft = await draftInvoice();
    await issueInvoice(draft.id, new Date(2026, 9, 1));
    const { pdfSha256 } = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    await sendDocumentPdf(draft.id);
    const attachment = vi.mocked(mailEnqueue).mock.calls.at(-1)![0].attachments![0]!;
    expect(sha(Buffer.from(attachment.contentBase64, "base64"))).toBe(pdfSha256);
  });

  it("brouillon et devis signé : pas d'archive (rendu ou preuve de signature servis par l'appelant)", async () => {
    const draft = await draftInvoice();
    expect(await issuedDocumentPdf(draft.id)).toBeNull();
    await prisma.invoice.update({ where: { id: draft.id }, data: { documentType: InvoiceDocumentType.QUOTE, number: "D-2026-001", status: InvoiceStatus.ISSUED, quoteStatus: "ACCEPTED" } });
    expect(await issuedDocumentPdf(draft.id)).toBeNull();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).pdfPath).toBeNull();
  });

  it("devis émis non signé : PDF archivé, comme une facture (décision du 27/10/2026)", async () => {
    const draft = await draftInvoice();
    await prisma.invoice.update({ where: { id: draft.id }, data: { documentType: InvoiceDocumentType.QUOTE, number: "D-2026-002", status: InvoiceStatus.ISSUED, quoteStatus: "SENT" } });
    const pdf = await issuedDocumentPdf(draft.id);
    expect(sha(pdf!)).toBe((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).pdfSha256);
  });

  it("deux premiers accès simultanés : une seule archive, un seul fichier", async () => {
    const draft = await draftInvoice();
    await prisma.invoice.update({
      where: { id: draft.id },
      data: { status: InvoiceStatus.ISSUED, number: "F-2026-0900", issueDate: new Date(2026, 9, 1), issuedAt: new Date() },
    });
    const [a, b] = await Promise.all([issuedDocumentPdf(draft.id), issuedDocumentPdf(draft.id)]);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(sha(a!)).toBe(row.pdfSha256);
    expect(sha(b!)).toBe(row.pdfSha256);
    const files = (await fs.readdir(issuedPdfAbsolutePath("issued-documents"))).filter((f) => f.includes(draft.id));
    expect(files).toHaveLength(1);
  });

  it("fichier altéré : toujours servi tel quel, alerte admin ; fichier perdu : rendu du moment, archive non remplacée", async () => {
    const draft = await draftInvoice();
    await issueInvoice(draft.id, new Date(2026, 9, 1));
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } });
    const abs = issuedPdfAbsolutePath(row.pdfPath!);

    // Archive chiffrée (27/10/2026) : un octet ajouté fait échouer l'authentification du chiffrement ; le fichier est
    // signalé illisible et le rendu du moment est servi, jamais le fichier altéré.
    await fs.appendFile(abs, "x");
    const tampered = await issuedDocumentPdf(draft.id);
    expect(tampered!.subarray(0, 4).toString()).toBe("%PDF");
    expect(alertAdmin.mock.calls.at(-1)![0]).toContain("PDF archivé à vérifier");
    expect(String(alertAdmin.mock.calls.at(-1)![1])).toMatch(/illisible/);
    // Rechargements : pas d'alerte de plus dans les 24 h.
    await issuedDocumentPdf(draft.id);
    await issuedDocumentPdf(draft.id);
    expect(alertAdmin).toHaveBeenCalledTimes(1);

    await fs.rm(abs);
    const rerendered = await issuedDocumentPdf(draft.id);
    expect(rerendered!.subarray(0, 4).toString()).toBe("%PDF");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.id } })).pdfPath).toBe(row.pdfPath);
    expect(alertAdmin).toHaveBeenCalledTimes(1);
  });

  it("rattrapage : les émis sans PDF sont archivés, une seule fois", async () => {
    for (const n of ["F-2026-0901", "F-2026-0902"]) {
      const draft = await draftInvoice();
      await prisma.invoice.update({
        where: { id: draft.id },
        data: { status: InvoiceStatus.ISSUED, number: n, issueDate: new Date(2026, 9, 1), issuedAt: new Date() },
      });
    }
    expect(await archivePendingIssuedPdfs()).toBe(2);
    expect(await archivePendingIssuedPdfs()).toBe(0);
    expect(await prisma.invoice.count({ where: { pdfPath: null, documentType: "INVOICE", status: "ISSUED" } })).toBe(0);
  });
});
