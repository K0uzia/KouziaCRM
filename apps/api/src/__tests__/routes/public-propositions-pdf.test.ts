import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// P0 du 25/10/2026 (recette du site contre d6f6af3) : le PDF public et /lisible d'un devis à propositions doivent être ceux
// du PDF admin (même chargement), avant et après signature ; aucun lien lisible ne mène à « introuvable ».
vi.mock("@/lib/email/smtp.js", async (orig) => ({ ...(await orig<typeof import("@/lib/email/smtp.js")>()), isSmtpConfigured: async () => false }));

const { buildApp } = await import("@/app.js");
const { signDocumentToken } = await import("@/lib/documents/public-token.js");
const { renderDocumentPdf } = await import("@/lib/pdf/document-pdf.js");
const { pdfReadingText } = await import("@/lib/pdf/readable.js");

const ADMIN = "admin-public-propositions@kouzia.test";
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

const admin = (method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { cookie }, ...(payload ? { payload: payload as never } : {}) });

async function issuedQuote() {
  const client = await createClient({ displayName: "Client Public Formules", type: "B2B" });
  const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
  await admin("POST", "/api/promo-codes", { code: "OUVERTURE30", kind: "PERCENT", percent: 30, months: 12, conditionText: "structure créée il y a moins de 12 mois" });
  const q = (
    await admin("POST", "/api/invoices", {
      clientId: client.id,
      documentType: "QUOTE",
      options: [
        { label: "Paiement unique", billingMode: "ONE_OFF", paymentPlanOffer: "TWO", lines: [{ description: "Création du site vitrine", quantity: 1, unitPriceEuros: 2400 }] },
        {
          label: "Abonnement 3 ans",
          billingMode: "RECURRING",
          promoCode: "OUVERTURE30",
          lines: [{ description: "Site tout compris", quantity: 1, unitPriceEuros: 1500, isSubscription: true, billingInterval: "YEAR", billingDay: 1, serviceId: svc.id, commitmentMonths: 36 }],
        },
      ],
    })
  ).json();
  expect((await admin("POST", `/api/invoices/${q.id}/issue`, { email: { send: false } })).statusCode).toBe(200);
  return q as { id: string; options: Array<{ id: string }> };
}

const publicPdf = (id: string) => app.inject({ method: "GET", url: `/api/public/documents/${signDocumentToken(id)}` });
const publicReadable = (id: string) => app.inject({ method: "GET", url: `/api/public/documents/${signDocumentToken(id)}/lisible` });

describe("devis à propositions : PDF public et version lisible (P0)", () => {
  it("avant signature : PDF public identique au PDF admin, lisible avec proposals, proposalsAt et le code promo", async () => {
    const q = await issuedQuote();
    const pub = await publicPdf(q.id);
    expect(pub.statusCode).toBe(200);
    const publicText = await pdfReadingText(pub.rawPayload);
    const adminText = await pdfReadingText((await renderDocumentPdf(q.id))!);
    expect(publicText).toBe(adminText);
    expect(publicText).toContain("Proposition A : Paiement unique");
    expect(publicText).toContain("Code promo OUVERTURE30");

    const readable = await publicReadable(q.id);
    expect(readable.statusCode, readable.body).toBe(200);
    const doc = readable.json();
    expect(doc.table).toBeNull();
    expect(doc.proposalsAt).toBe(2);
    expect(doc.proposals.map((p: { heading: string }) => p.heading)).toEqual(["Proposition A : Paiement unique", "Proposition B : Abonnement 3 ans"]);
  });

  it("après signature : PDF signé archivé servi, lisible figé avec la proposition retenue (jamais 404)", async () => {
    const q = await issuedQuote();
    expect((await admin("POST", `/api/quotes/${q.id}/sign-offline`, { signerName: "Léa Martin", optionId: q.options[1]!.id })).statusCode).toBe(200);
    const readable = await publicReadable(q.id);
    expect(readable.statusCode, readable.body).toBe(200);
    const doc = readable.json();
    expect(doc.details).toContainEqual({ label: "Proposition retenue", value: "B : Abonnement 3 ans" });
    expect(doc.proposals.map((p: { heading: string }) => p.heading)).toEqual(["Proposition A : Paiement unique (non retenue)", "Proposition B : Abonnement 3 ans"]);
    expect(doc.source).toBe("ARCHIVE");
    // Figée à la signature, pas au premier accès.
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } })).readableSnapshot).toMatch(/^enc1:/);
  });

  it("PDF du bouton « PDF » de l'ERP : même document que le PDF public", async () => {
    const q = await issuedQuote();
    const adminPdf = await admin("GET", `/api/invoices/${q.id}/pdf`);
    expect(adminPdf.statusCode).toBe(200);
    expect(await pdfReadingText(adminPdf.rawPayload)).toBe(await pdfReadingText((await publicPdf(q.id)).rawPayload));
  });

  it("lien lisible annoncé seulement s'il peut être servi ; devis signé sans version figée rattrapé", async () => {
    const { readableLinkAvailable, backfillReadableSnapshots } = await import("@/lib/pdf/readable-documents.js");
    const base = { number: "D-2026-0001", documentType: "QUOTE", readableSnapshot: null };
    expect(readableLinkAvailable({ ...base, quoteStatus: "SENT" })).toBe(true);
    expect(readableLinkAvailable({ ...base, quoteStatus: "ACCEPTED" })).toBe(false);
    expect(readableLinkAvailable({ ...base, quoteStatus: "ACCEPTED", readableSnapshot: '{"unavailable":"text-mismatch"}' })).toBe(false);
    expect(readableLinkAvailable({ ...base, number: null, quoteStatus: "SENT" })).toBe(false);

    const q = await issuedQuote();
    await admin("POST", `/api/quotes/${q.id}/sign-offline`, { signerName: "Léa Martin", optionId: q.options[0]!.id });
    // Devis signé avant le correctif : aucune version figée ; le rattrapage la fige depuis le PDF signé archivé.
    await prisma.invoice.update({ where: { id: q.id }, data: { readableSnapshot: null } });
    const result = await backfillReadableSnapshots();
    expect(result.frozen).toBeGreaterThanOrEqual(1);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } });
    expect(readableLinkAvailable(row)).toBe(true);
    expect((await publicReadable(q.id)).statusCode).toBe(200);
  });
});
