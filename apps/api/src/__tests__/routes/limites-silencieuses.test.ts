import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@/lib/prisma.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

let app: FastifyInstance;
let cookie = "";
const DAY = 86_400_000;

// Au-delà des anciennes limites silencieuses : 60 retraits (50), 60 déclarations URSSAF (50), 120 versements et
// 130 encaissements Stripe en attente (100).
beforeAll(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.user.deleteMany({ where: { email: "admin-limites@kouzia.test" } });
  const user = await prisma.user.create({ data: { email: "admin-limites@kouzia.test", passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
  app = await buildApp({ silent: true, serveStatic: false });
  await prisma.ownerWithdrawal.createMany({ data: Array.from({ length: 60 }, (_, i) => ({ amountCents: 1_000, date: new Date(Date.now() - i * DAY) })) });
  await prisma.urssafDeclaration.createMany({
    data: Array.from({ length: 60 }, (_, i) => {
      const start = new Date(2021, i, 1);
      return { periodKey: `M-${i}`, periodicity: "MONTHLY", periodStart: start, periodEnd: new Date(2021, i + 1, 0), deadline: new Date(2021, i + 1, 30), encaisseCents: 0, amountDueCents: 0 };
    }) as never,
  });
  await prisma.stripePayout.createMany({ data: Array.from({ length: 120 }, (_, i) => ({ stripePayoutId: `po_${i}`, amountCents: 5_000, status: "paid", arrivalDate: new Date(Date.now() - i * DAY) })) });
  await prisma.payment.createMany({
    data: Array.from({ length: 130 }, (_, i) => ({ amountCents: 1_000, feeCents: 30, paidAt: new Date(Date.now() - i * 3_600_000), stripePaymentIntentId: `pi_attente_${i}` })),
  });
});
afterAll(async () => {
  await app.close();
  await resetDb();
});

const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

describe("listes complètes, nombres du serveur", () => {
  it("retraits : les 60, et leur nombre", async () => {
    const body = (await get("/api/owner-pay")).json() as { withdrawals: unknown[]; withdrawalsTotal: number; withdrawalsTruncated: boolean };
    expect(body.withdrawals).toHaveLength(60);
    expect(body).toMatchObject({ withdrawalsTotal: 60, withdrawalsTruncated: false });
  });

  it("déclarations URSSAF : les 60, sans en-tête de troncature", async () => {
    const res = await get("/api/urssaf/declarations");
    expect(res.json()).toHaveLength(60);
    expect(res.headers["x-liste-tronquee"]).toBeUndefined();
  });

  it("versements Stripe : les 120 ; en attente : somme et nombre sur les 130, pas sur 100", async () => {
    const body = (await get("/api/stripe/payouts")).json() as {
      payouts: unknown[];
      payoutsTotal: number;
      payoutsTruncated: boolean;
      pending: { grossCents: number; feeCents: number; count: number; payments: unknown[] };
    };
    expect(body.payouts).toHaveLength(120);
    expect(body).toMatchObject({ payoutsTotal: 120, payoutsTruncated: false });
    expect(body.pending).toMatchObject({ grossCents: 130_000, feeCents: 3_900, count: 130 });
    expect(body.pending.payments).toHaveLength(130);
  });
});
