import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { EmailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-cloche@kouzia.test";
const PASSWORD = "mot-de-passe-de-test";
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});

afterAll(async () => {
  await app.close();
});

/** Nouvelle session, comme un autre appareil ou un nouveau navigateur. */
async function login(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: ADMIN, password: PASSWORD } });
  return `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)?.value}`;
}

async function unread(cookie: string): Promise<number> {
  const res = await app.inject({ method: "GET", url: "/api/notifications/feed", headers: { cookie } });
  expect(res.statusCode).toBe(200);
  const feed = res.json() as { items: { at: string }[]; seenAt: string };
  return feed.items.filter((i) => i.at > feed.seenAt).length;
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword(PASSWORD) } });
  const client = await createClient();
  const thread = await prisma.emailThread.create({
    data: { subject: "Q", participants: "[]", lastMessageAt: new Date(), clientId: client.id },
  });
  await prisma.emailMessage.create({
    data: {
      threadId: thread.id,
      direction: EmailDirection.INBOUND,
      toAddresses: "[]",
      receivedAt: new Date(),
      messageId: "<q@gmail.com>",
      fromAddress: "client@gmail.com",
      subject: "Question",
    },
  });
  await prisma.payment.create({ data: { amountCents: 7900, paidAt: new Date() } });
  await prisma.clientTestimonial.create({ data: { clientId: client.id, authorName: "Marie", body: "Très bien" } });
});

describe("état lu des notifications", () => {
  it("marqué lu sur un appareil, lu sur tous : e-mail, paiement et avis", async () => {
    const pc = await login();
    expect(await unread(pc)).toBe(3);

    const res = await app.inject({ method: "POST", url: "/api/notifications/seen", headers: { cookie: pc } });
    expect(res.statusCode).toBe(200);

    const phone = await login();
    expect(await unread(phone)).toBe(0);
    expect(await unread(pc)).toBe(0);
  });

  it("une notification postérieure redevient non lue", async () => {
    const pc = await login();
    await app.inject({ method: "POST", url: "/api/notifications/seen", headers: { cookie: pc } });
    await new Promise((r) => setTimeout(r, 5));
    await prisma.payment.create({ data: { amountCents: 1000, paidAt: new Date() } });
    expect(await unread(await login())).toBe(1);
  });

  it("réservé à l'administrateur connecté", async () => {
    const res = await app.inject({ method: "POST", url: "/api/notifications/seen" });
    expect(res.statusCode).toBe(401);
  });
});
