import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { fillClauseVariables } from "@/lib/company/legal-clauses.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Mention de TVA (refactor validé le 26/10/2026) : une seule source, le réglage vatMention ; la clause VAT le reprend par
// {{mention_tva}} ; un devis émis garde la mention de son émission ; facture et avoir portent celle du réglage à leur
// date ; un PDF archivé ne bouge pas.
const { buildApp } = await import("@/app.js");
const { issueInvoice } = await import("@/lib/invoices/transitions.js");
const { loadDocumentForPdf, pdfDataOfLoaded } = await import("@/lib/pdf/document-pdf.js");
const { issuedDocumentPdf } = await import("@/lib/pdf/issued-archive.js");

const OLD = "TVA non applicable, art. 293 B du CGI";
const NEW = "TVA non applicable, art. L. 233-3 du CIBS";
const ADMIN = "admin-tva@kouzia.test";
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
  await prisma.legalClause.deleteMany({});
  await seedCompanySettings();
  invalidateCompanySettingsCache();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: "mot-de-passe-de-test" } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function setMention(vatMention: string) {
  const res = await call("PATCH", "/api/settings/identity", { vatMention });
  expect(res.statusCode, res.body).toBe(200);
  invalidateCompanySettingsCache();
}

async function issuedQuote() {
  await call("GET", "/api/legal-clauses");
  const client = await createClient({ displayName: "Client TVA", type: "B2B" });
  const q = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 900 }] })).json();
  const issued = await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } });
  expect(issued.statusCode, issued.body).toBe(200);
  return q.id as string;
}

const pdfData = async (id: string) => pdfDataOfLoaded((await loadDocumentForPdf(id))!);
const vatClause = (data: Awaited<ReturnType<typeof pdfData>>) => data.invoice.legalClauses?.find((c) => c.title === "Franchise en base de TVA");

describe("mention de TVA : une seule source, le réglage", () => {
  it("clause par défaut = {{mention_tva}}, remplie depuis le réglage", async () => {
    const clauses = (await call("GET", "/api/legal-clauses")).json() as Array<{ kind: string; body: string }>;
    expect(clauses.find((c) => c.kind === "VAT")!.body).toBe("{{mention_tva}}");
    const company = { legalName: "Kouzia", tradeName: null, email: null, addressLine1: "1 rue", addressLine2: null, postalCode: "29690", city: "Huelgoat" };
    expect(fillClauseVariables("{{mention_tva}}", { ...company, vatMention: NEW })).toBe(NEW);
  });

  it("devis émis avant le changement : garde sa mention ; devis émis après : la nouvelle", async () => {
    const before = await issuedQuote();
    await setMention(NEW);
    const old = await pdfData(before);
    expect(old.company.vatMention).toBe(OLD);
    expect(vatClause(old)!.body).toBe(OLD);

    const after = await pdfData(await issuedQuote());
    expect(after.company.vatMention).toBe(NEW);
    expect(vatClause(after)!.body).toBe(NEW);
  });

  it("facture reprenant les clauses d'un devis : mention du réglage à sa date ; facture archivée identique", async () => {
    const client = await createClient({ displayName: "Client facture", type: "B2B" });
    const draft = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: client.id,
        subtotalCents: 50_000,
        totalCents: 50_000,
        legalClausesSnapshot: [{ kind: "VAT", title: "Franchise en base de TVA", body: OLD, audience: "ALL", position: 0 }],
        lines: { create: { position: 1, description: "Site vitrine", quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000 } },
      },
    });
    await issueInvoice(draft.id, new Date(2026, 9, 1));
    const archived = await issuedDocumentPdf(draft.id);

    await setMention(NEW);
    const data = await pdfData(draft.id);
    expect(data.company.vatMention).toBe(NEW);
    expect(fillClauseVariables(vatClause(data)!.body, data.company)).toBe(NEW);
    expect(sha((await issuedDocumentPdf(draft.id))!)).toBe(sha(archived!));
  });

  it("mention vide refusée : la mention est obligatoire sur les documents", async () => {
    expect((await call("PATCH", "/api/settings/identity", { vatMention: "   " })).statusCode).toBe(400);
  });
});
