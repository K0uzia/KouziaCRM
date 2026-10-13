import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
const { signReceiptToken, signDocumentToken } = await import("@/lib/documents/public-token.js");

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
});

describe("GET /api/public/receipts/:token", () => {
  it("sert le reçu archivé ; jeton de document ou invalide : 404 identique", async () => {
    const client = await createClient({ type: "B2C", displayName: "Lou Martin" });
    const invoice = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        number: "F-2026-0950",
        clientId: client.id,
        subtotalCents: 30_000,
        totalCents: 30_000,
        issueDate: new Date(2026, 9, 1),
      },
    });
    const payment = await prisma.payment.create({
      data: { invoiceId: invoice.id, amountCents: 30_000, paidAt: new Date(2026, 9, 2), method: PaymentMethod.CARD },
    });
    const ok = await app.inject({ method: "GET", url: `/api/public/receipts/${signReceiptToken(payment.id)}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("application/pdf");
    expect(ok.headers["content-disposition"]).toBe(
      `inline; filename="Recu-F-2026-0950-${payment.paidAt.toISOString().slice(0, 10)}-${payment.id.slice(-6)}.pdf"`,
    );
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(createHash("sha256").update(ok.rawPayload).digest("hex")).toBe(row.receiptPdfSha256);

    const asDocument = await app.inject({ method: "GET", url: `/api/public/receipts/${signDocumentToken(invoice.id)}` });
    const invalid = await app.inject({ method: "GET", url: "/api/public/receipts/abc.def" });
    expect(asDocument.statusCode).toBe(404);
    expect(asDocument.json()).toEqual(invalid.json());
  });
});
