import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// SMTP « configuré » sans envoi réseau : les codes se lisent dans la file.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

const { buildApp } = await import("@/app.js");
const { issueQuote } = await import("@/lib/invoices/transitions.js");

const EMAIL = "lou@exemple.fr";
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
afterEach(async () => {
  await resetDb();
});

async function lastCode(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const rows = await prisma.emailOutbox.findMany({ orderBy: { createdAt: "desc" } });
    const code = rows.map((r) => parsePayload(outboxPayloadRaw(r)).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (code) return code;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error("aucun code");
}

/** Devis ponctuel émis pour un professionnel, et session /suivi ouverte par le code de connexion. */
async function setup() {
  const client = await createClient({ displayName: "Atelier Lou", type: "B2B" });
  await prisma.client.update({
    where: { id: client.id },
    data: { companyName: "Atelier Lou", lastName: "Cliente", emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) },
  });
  const quote = await prisma.invoice.create({
    data: {
      clientId: client.id,
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      subtotalCents: 90000,
      totalCents: 90000,
      lines: { create: [{ position: 1, description: "Site vitrine", quantity: 1, unitPriceCents: 90000, lineTotalCents: 90000 }] },
    },
  });
  await issueQuote(quote.id);
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code: await lastCode() } });
  const kz_portal = verify.cookies.find((c) => c.name === "kz_portal")!.value;
  const session = await prisma.portalSession.findFirstOrThrow({ where: { clientId: client.id } });
  return { quoteId: quote.id, kz_portal, sessionId: session.id, loginAt: session.createdAt };
}

/** Connexion faite il y a `minutes` minutes (session toujours valide). */
async function ageSession(sessionId: string, minutes: number) {
  const createdAt = new Date(Date.now() - minutes * 60_000);
  await prisma.portalSession.update({ where: { id: sessionId }, data: { createdAt } });
  return createdAt;
}

/** Second devis émis pour le même client (session déjà ouverte). */
async function setup2() {
  const first = await prisma.invoice.findFirstOrThrow({ where: { documentType: InvoiceDocumentType.QUOTE } });
  const quote = await prisma.invoice.create({
    data: {
      clientId: first.clientId,
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      subtotalCents: 50000,
      totalCents: 50000,
      lines: { create: [{ position: 1, description: "Logo", quantity: 1, unitPriceCents: 50000, lineTotalCents: 50000 }] },
    },
  });
  await issueQuote(quote.id);
  return quote.id;
}

const tracked = async (kz_portal: string, quoteId: string) =>
  ((await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json().documents as Array<Record<string, unknown>>).find(
    (d) => d.id === quoteId,
  )!;

function decide(quoteId: string, kz_portal: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/api/public/quotes/${quoteId}/decision`,
    cookies: { kz_portal },
    payload: { decision: "ACCEPT", firstName: "Lou", lastName: "Cliente", signatureMode: "TYPED", ...extra },
  });
}

describe("signature dans /suivi sans second code", () => {
  it("session valide : signé sans code, preuve complète avec l'heure de connexion", async () => {
    const { quoteId, kz_portal, loginAt } = await setup();
    const doc = await tracked(kz_portal, quoteId);
    expect(doc.signCodeRequired).toBe(false);
    expect("sessionFreshUntil" in doc).toBe(false);

    const res = await decide(quoteId, kz_portal);
    expect(res.statusCode).toBe(200);
    expect(res.json().quoteStatus).toBe("ACCEPTED");
    const proof = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId } });
    expect(proof).toMatchObject({ source: "PORTAL", signerName: "Lou CLIENTE", verifiedEmailMasked: "l***@exemple.fr" });
    expect(proof.codeVerifiedAt?.toISOString()).toBe(loginAt.toISOString());
    expect(proof.ipAddress).toBeTruthy();
    expect(proof.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(proof.originalPdfSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("connexion ancienne mais session valide (3 jours) : signé sans code ; session expirée : 401, rien d'enregistré", async () => {
    const { quoteId, kz_portal, sessionId } = await setup();
    const loginAt = await ageSession(sessionId, 3 * 24 * 60);
    expect((await tracked(kz_portal, quoteId)).signCodeRequired).toBe(false);
    const signed = await decide(quoteId, kz_portal);
    expect(signed.statusCode).toBe(200);
    const proof = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId } });
    expect(proof.codeVerifiedAt?.toISOString()).toBe(loginAt.toISOString());

    const other = await setup2();
    await prisma.portalSession.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await decide(other, kz_portal);
    expect(expired.statusCode).toBe(401);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: other } })).quoteStatus).toBe("SENT");
    expect(await prisma.quoteAcceptanceAudit.count({ where: { quoteId: other } })).toBe(0);
  });

  it("code envoyé quand même (ancien site) : vérifié, un mauvais code est refusé même avec une connexion récente", async () => {
    const { quoteId, kz_portal } = await setup();
    const wrong = await decide(quoteId, kz_portal, { code: "000000" });
    expect(wrong.statusCode).toBe(401);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId } })).quoteStatus).toBe("SENT");
  });

  it("devis déjà signé : plus de champ de signature dans le suivi ; sans session : 401", async () => {
    const { quoteId, kz_portal } = await setup();
    await decide(quoteId, kz_portal);
    const doc = await tracked(kz_portal, quoteId);
    expect(doc.quoteStatus).toBe("ACCEPTED");
    expect("signCodeRequired" in doc).toBe(false);
    const anonymous = await app.inject({
      method: "POST",
      url: `/api/public/quotes/${quoteId}/decision`,
      payload: { decision: "ACCEPT", firstName: "Lou", lastName: "Cliente", signatureMode: "TYPED" },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
