import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import { pdfText } from "../../helpers/pdf-text.js";

// Décision du 27/10/2026 : le PDF d'un devis émis est figé à l'émission, comme celui des factures. Un changement
// d'adresse ou de SIRET dans les réglages ne modifie plus un devis déjà envoyé ; le devis présenté avant signature est
// ce PDF figé (son empreinte figure sur le devis signé).
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-devis-fige@kouzia.test";
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

async function issuedQuote() {
  const client = await createClient({ displayName: "Client Devis Figé", type: "B2B" });
  const q = (await call("POST", "/api/invoices", { clientId: client.id, documentType: "QUOTE", billingMode: "ONE_OFF", lines: [{ description: "Site", quantity: 1, unitPriceEuros: 900 }] })).json();
  expect((await call("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  return q.id as string;
}

async function moveCompany() {
  await prisma.companySettings.updateMany({ data: { addressLine1: "99 avenue Nouvelle", siret: "11111111111111" } });
  invalidateCompanySettingsCache();
}

describe("PDF d'un devis émis", () => {
  it("un changement de réglages après l'émission ne modifie pas le PDF", async () => {
    const id = await issuedQuote();
    const before = (await call("GET", `/api/invoices/${id}/pdf`)).rawPayload;
    expect(pdfText(before)).toContain("1 rue Test");
    await moveCompany();
    const after = (await call("GET", `/api/invoices/${id}/pdf`)).rawPayload;
    expect(pdfText(after)).toContain("1 rue Test");
    expect(pdfText(after)).not.toContain("99 avenue Nouvelle");
    expect(createHash("sha256").update(after).digest("hex")).toBe(createHash("sha256").update(before).digest("hex"));
  });

  it("le devis présenté avant signature est le PDF figé", async () => {
    const id = await issuedQuote();
    const frozen = (await call("GET", `/api/invoices/${id}/pdf`)).rawPayload;
    await moveCompany();
    const { acceptQuoteByClient } = await import("@/lib/invoices/transitions.js");
    await acceptQuoteByClient(id, "Léa Martin", {
      source: "PORTAL",
      context: { ipAddress: "203.0.113.7", userAgent: "Mozilla/5.0 Test" },
      signature: { mode: "TYPED", emailMasked: "l***@exemple.fr", authMethod: "SIGN_CODE", codeVerifiedAt: new Date() },
    });
    const audit = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId: id } });
    expect(audit.originalPdfSha256).toBe(createHash("sha256").update(frozen).digest("hex"));
  });
});
