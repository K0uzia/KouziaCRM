import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { EmailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { backfillEncryptedEmails } from "@/lib/privacy/at-rest.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Décision d'Alexandre du 27/10/2026 : corps des e-mails de la messagerie et IBAN des opérations bancaires chiffrés au
// repos (migration 20261221090000). Écritures chiffrées, anciennes lignes recopiées par le worker, API inchangée.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
  resolveFromAddress: async () => "Kouzia <contact@kouzia.test>",
}));
const { buildApp } = await import("@/app.js");

const ADMIN = "admin-messagerie-chiffree@kouzia.test";
const SECRET = "Code d'accès du portail : 4521, rappel au 06 11 22 33 44";
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

const rawMessage = async (id: string) =>
  JSON.stringify((await prisma.$queryRawUnsafe<unknown[]>(`SELECT "bodyText", "bodyHtml", "bodyTextEncrypted", "bodyHtmlEncrypted" FROM "EmailMessage" WHERE "id" = ?`, id))[0]);

describe("corps des e-mails chiffrés au repos", () => {
  it("message envoyé depuis la messagerie : corps chiffré en base, lisible par l'API", async () => {
    const res = await call("POST", "/api/emails/send", { to: "lea@exemple.fr", subject: "Accès", body: SECRET });
    expect(res.statusCode, res.body).toBe(201);
    const { threadId, message } = res.json() as { threadId: string; message: { id: string; bodyText: string } };
    expect(message.bodyText).toBe(SECRET);
    expect(message).not.toHaveProperty("bodyTextEncrypted");
    expect(await rawMessage(message.id)).not.toContain("4521");
    const thread = (await call("GET", `/api/emails/${threadId}`)).json() as { messages: Array<{ bodyText: string }> };
    expect(thread.messages[0]!.bodyText).toBe(SECRET);
    const detail = (await call("GET", `/api/emails/messages/${message.id}`)).json() as { bodyText: string };
    expect(detail.bodyText).toBe(SECRET);
  });

  it("message antérieur en clair : recopié chiffré par le worker, lecture identique, idempotent", async () => {
    const thread = await prisma.emailThread.create({ data: { subject: "Ancien", participants: "[]", lastMessageAt: new Date() } });
    const m = await prisma.emailMessage.create({
      data: { threadId: thread.id, direction: EmailDirection.INBOUND, messageId: "<ancien@test>", fromAddress: "lea@exemple.fr", toAddresses: "[]", subject: "Ancien", receivedAt: new Date(), bodyText: SECRET, bodyHtml: `<p>${SECRET}</p>`, bodyFetched: true },
    });
    expect(await rawMessage(m.id)).toContain("4521");
    expect((await backfillEncryptedEmails()).messages).toBe(1);
    expect(await rawMessage(m.id)).not.toContain("4521");
    const detail = (await call("GET", `/api/emails/messages/${m.id}`)).json() as { bodyText: string; bodyHtml: string };
    expect([detail.bodyText, detail.bodyHtml]).toEqual([SECRET, `<p>${SECRET}</p>`]);
    expect((await backfillEncryptedEmails()).messages).toBe(0);
  });
});

describe("IBAN des opérations bancaires chiffré au repos", () => {
  it("IBAN antérieur en clair : recopié chiffré, ancienne colonne vidée, idempotent", async () => {
    const iban = "FR7630006000011234567890189";
    // Table hors de resetDb : opérations de test retirées avant et après.
    await prisma.bankTransaction.deleteMany({ where: { revolutId: "rev-tx-1" } });
    const tx = await prisma.bankTransaction.create({ data: { revolutId: "rev-tx-1", bookedAt: new Date(), amountCents: 50_000, counterpartyName: "Léa Martin", counterpartyIban: iban } });
    expect((await backfillEncryptedEmails()).ibans).toBe(1);
    const row = await prisma.bankTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(row.counterpartyIban).toBeNull();
    const { decrypt } = await import("@/lib/crypto.js");
    expect(decrypt(row.counterpartyIbanEncrypted!)).toBe(iban);
    expect((await backfillEncryptedEmails()).ibans).toBe(0);
    await prisma.bankTransaction.deleteMany({ where: { revolutId: "rev-tx-1" } });
  });
});
