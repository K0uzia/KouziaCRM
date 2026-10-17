import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");
const ADMIN = "admin-tableau@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;
let cookie = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

describe("tableau de bord en un appel", () => {
  it("refuse sans session et valide la portée", async () => {
    expect((await app.inject({ method: "GET", url: "/api/dashboard/overview" })).statusCode).toBe(401);
    expect((await get("/api/dashboard/overview?scope=decennie")).statusCode).toBe(400);
  });

  it("mêmes valeurs que les routes unitaires, 5 messages de la Réception sans corps", async () => {
    const client = await createClient();
    const inv = await prisma.invoice.create({
      data: { documentType: "INVOICE", invoiceType: "SIMPLE", status: "ISSUED", number: "F-2026-0001", clientId: client.id, issueDate: new Date(), subtotalCents: 120000, totalCents: 120000 },
    });
    await prisma.payment.create({ data: { invoiceId: inv.id, amountCents: 20000, paidAt: new Date() } });
    const account = await prisma.mailAccount.create({ data: { email: "contact@kouzia.test", isDefault: true } });
    const inbox = await prisma.mailFolder.create({ data: { accountId: account.id, imapPath: "INBOX", displayName: "Réception", role: "INBOX" } });
    for (let i = 0; i < 7; i++) {
      const t = await prisma.emailThread.create({
        data: { subject: `Fil ${i}`, participants: "[]", lastMessageAt: new Date(Date.now() - i * 60_000) },
      });
      await prisma.emailMessage.create({
        data: {
          threadId: t.id, direction: "INBOUND", messageId: `<fil-${i}@kouzia.test>`, fromAddress: `exp${i}@exemple.test`,
          subject: `Fil ${i}`, toAddresses: "[]", bodyText: "corps ".repeat(500), receivedAt: new Date(Date.now() - i * 60_000),
          folderId: inbox.id, imapUid: i + 1,
        },
      });
    }

    const res = await get("/api/dashboard/overview?scope=month");
    expect(res.statusCode).toBe(200);
    const o = res.json();
    const snapshot = (await get("/api/dashboard?scope=month")).json();
    expect(o.cashflow).toEqual(snapshot.cashflow);
    expect(o.pendingWithBalance).toEqual(snapshot.pendingWithBalance);
    expect(o.reminders).toEqual((await get("/api/reminders/pending")).json());
    expect(o.mrr).toEqual((await get("/api/subscriptions/mrr")).json());
    const summary = (await get("/api/obligations/summary")).json();
    expect(o.obligations.summary).toEqual(summary.summary);
    const ownerPay = (await get("/api/owner-pay")).json();
    expect(o.ownerPay.availableCents).toBe(ownerPay.availableCents);

    expect(o.mail.messages.map((t: { subject: string }) => t.subject)).toEqual(["Fil 0", "Fil 1", "Fil 2", "Fil 3", "Fil 4"]);
    expect(o.mail.messages[0].fromAddress).toBe("exp0@exemple.test");
    expect(o.mail.unreadCount).toBe(7);
    expect(JSON.stringify(o.mail)).not.toContain("corps");
    const sync = (await get("/api/emails/sync-status")).json();
    expect(o.mailSync).toEqual({ imapConfigured: sync.imapConfigured, lastSyncAt: sync.lastSyncAt });
  });
});
