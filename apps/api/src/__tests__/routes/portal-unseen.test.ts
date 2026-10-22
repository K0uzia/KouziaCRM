import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { computeEmailHash } from "@/lib/clients/email-hash.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/mailer/index.js")>()),
  sendOutboxImmediately: async () => true,
}));

const { buildApp } = await import("@/app.js");

const EMAIL = "lou@exemple.fr";
const HOUR = 3_600_000;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await prisma.clientProject.deleteMany();
  await seedCompanySettings();
});
afterEach(async () => {
  await prisma.clientProject.deleteMany();
  await resetDb();
});

async function login() {
  await prisma.emailOutbox.deleteMany();
  await app.inject({ method: "POST", url: "/api/public/auth/code", payload: { email: EMAIL } });
  let code: string | undefined;
  for (let i = 0; i < 50 && !code; i++) {
    const rows = await prisma.emailOutbox.findMany();
    code = rows.map((r) => parsePayload(outboxPayloadRaw(r)).subject.match(/^(\d{6}) /)?.[1]).find(Boolean);
    if (!code) await new Promise((ok) => setTimeout(ok, 20));
  }
  const verify = await app.inject({ method: "POST", url: "/api/public/auth/verify", payload: { email: EMAIL, code } });
  return verify.cookies.find((c) => c.name === "kz_portal")!.value;
}

async function lou() {
  const c = await createClient({ displayName: "Lou Martin" });
  await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(EMAIL), emailHash: computeEmailHash(EMAIL) } });
  return c;
}

let seq = 0;
function invoice(clientId: string, issuedAt: Date, documentType: InvoiceDocumentType = InvoiceDocumentType.INVOICE) {
  seq++;
  return prisma.invoice.create({
    data: {
      clientId,
      documentType,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      ...(documentType === InvoiceDocumentType.QUOTE ? { quoteStatus: "ACCEPTED" as const } : {}),
      number: `${documentType === InvoiceDocumentType.QUOTE ? "D" : "F"}-2026-09${seq}`,
      issueDate: issuedAt,
      issuedAt,
      subtotalCents: 50_000,
      totalCents: 50_000,
      lines: { create: [{ position: 1, description: "Site", quantity: 1, unitPriceCents: 50_000, lineTotalCents: 50_000 }] },
    },
  });
}

const tracking = async (kz_portal: string) =>
  (await app.inject({ method: "GET", url: "/api/public/tracking", cookies: { kz_portal } })).json() as Record<string, unknown> & {
    unseen: { projects: number; documents: number; payments: number };
    documents: Array<Record<string, unknown> & { milestones?: Array<Record<string, unknown>> }>;
    paymentHistory: { items: Array<Record<string, unknown>> };
    projects?: Array<Record<string, unknown>>;
  };

/** Simule une dernière ouverture des trois rubriques il y a une heure. */
const visitedAnHourAgo = (clientId: string) =>
  prisma.clientPortalSeen.updateMany({ where: { clientId }, data: { seenAt: new Date(Date.now() - HOUR) } });

describe("/suivi : pastilles « non vu » (contrat du 19/10/2026)", () => {
  it("première visite : référence posée, aucune pastille ni isNew, unseen toujours présent", async () => {
    const c = await lou();
    await invoice(c.id, new Date(Date.now() - 2 * 24 * HOUR));
    const kz = await login();
    const body = await tracking(kz);
    expect(body.unseen).toEqual({ projects: 0, documents: 0, payments: 0 });
    expect(body.documents.every((d) => !("isNew" in d))).toBe(true);
    expect((await prisma.clientPortalSeen.findMany({ where: { clientId: c.id } })).map((r) => r.section).sort()).toEqual([
      "documents",
      "payments",
      "projects",
    ]);
    // Deuxième lecture : la référence ne bouge pas.
    const first = await prisma.clientPortalSeen.findMany({ where: { clientId: c.id }, orderBy: { section: "asc" } });
    await tracking(kz);
    expect(await prisma.clientPortalSeen.findMany({ where: { clientId: c.id }, orderBy: { section: "asc" } })).toEqual(first);
  });

  it("documents et paiements nouveaux depuis la dernière ouverture ; /seen remet la rubrique à zéro", async () => {
    const c = await lou();
    const old = await invoice(c.id, new Date(Date.now() - 2 * 24 * HOUR));
    const kz = await login();
    await tracking(kz);
    await visitedAnHourAgo(c.id);

    const fresh = await invoice(c.id, new Date());
    const payment = await prisma.payment.create({ data: { invoiceId: old.id, amountCents: 10_000, paidAt: new Date(Date.now() - 3 * 24 * HOUR) } });

    const body = await tracking(kz);
    expect(body.documents.find((d) => d.id === fresh.id)!.isNew).toBe(true);
    expect("isNew" in body.documents.find((d) => d.id === old.id)!).toBe(false);
    // Virement daté d'avant la visite mais saisi après : nouveau (date de saisie).
    expect(body.paymentHistory.items.find((i) => i.id === `payment-${payment.id}`)!.isNew).toBe(true);
    // Facture émise avec un reste dû (1) + règlement reçu (1).
    expect(body.unseen).toEqual({ projects: 0, documents: 1, payments: 2 });

    const seen = await app.inject({ method: "POST", url: "/api/public/seen", cookies: { kz_portal: kz }, payload: { section: "documents" } });
    expect(seen.statusCode).toBe(204);
    const after = await tracking(kz);
    expect(after.unseen).toEqual({ projects: 0, documents: 0, payments: 2 });
    expect(after.documents.every((d) => !("isNew" in d))).toBe(true);
  });

  it("échéance devenue exigible et projet modifié : isNew et compteurs", async () => {
    const c = await lou();
    const quote = await invoice(c.id, new Date(Date.now() - 2 * 24 * HOUR), InvoiceDocumentType.QUOTE);
    const ms = await prisma.paymentMilestone.create({
      data: { quoteId: quote.id, position: 1, label: "Acompte", percentBps: 3000, amountCents: 15_000, triggerText: "À la signature", status: "PENDING" },
    });
    const project = await prisma.clientProject.create({ data: { clientId: c.id, name: "Site vitrine", quoteId: quote.id } });
    const kz = await login();
    await tracking(kz);
    await visitedAnHourAgo(c.id);

    await prisma.paymentMilestone.update({ where: { id: ms.id }, data: { status: "DUE" } });
    await prisma.clientProject.update({ where: { id: project.id }, data: { status: "DONE" } });

    const body = await tracking(kz);
    expect(body.documents.find((d) => d.id === quote.id)!.milestones![0]!.isNew).toBe(true);
    expect(body.projects!.find((p) => p.id === project.id)!.isNew).toBe(true);
    expect(body.unseen).toEqual({ projects: 1, documents: 0, payments: 1 });
  });

  it("POST /seen : rubrique inconnue 400 unknown_section ; sans session 401", async () => {
    await lou();
    const kz = await login();
    const bad = await app.inject({ method: "POST", url: "/api/public/seen", cookies: { kz_portal: kz }, payload: { section: "emails" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ code: "unknown_section", error: "Rubrique inconnue." });
    const anon = await app.inject({ method: "POST", url: "/api/public/seen", payload: { section: "documents" } });
    expect(anon.statusCode).toBe(401);
  });
});
