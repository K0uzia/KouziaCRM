import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

const ADMIN = "admin-versements@kouzia.test";
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

describe("versements Stripe", () => {
  it("liste les versements avec leurs paiements et frais, et les encaissements en attente", async () => {
    const client = await createClient();
    const invoice = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.PAID,
        number: "F-2026-0100",
        clientId: client.id,
        subtotalCents: 20000,
        totalCents: 20000,
        issueDate: new Date(),
      },
    });
    const payout = await prisma.stripePayout.create({
      data: { stripePayoutId: "po_1", amountCents: 9700, status: "paid", arrivalDate: new Date() },
    });
    await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amountCents: 10000,
        paidAt: new Date(),
        method: PaymentMethod.CARD,
        stripePaymentIntentId: "pi_1",
        feeCents: 300,
        stripePayoutId: payout.id,
      },
    });
    await prisma.payment.create({
      data: {
        invoiceId: invoice.id,
        amountCents: 10000,
        paidAt: new Date(),
        method: PaymentMethod.CARD,
        stripePaymentIntentId: "pi_2",
        feeCents: 250,
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/stripe/payouts", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.payouts).toHaveLength(1);
    expect(body.payouts[0]).toMatchObject({ amountCents: 9700, grossCents: 10000, feeCents: 300 });
    expect(body.pending).toMatchObject({ grossCents: 10000, feeCents: 250 });
  });

  it("réservé à l'administrateur connecté", async () => {
    const res = await app.inject({ method: "GET", url: "/api/stripe/payouts" });
    expect(res.statusCode).toBe(401);
  });
});
