import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, MilestoneStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { openPortalSession, PORTAL_COOKIE } from "@/lib/portal/auth.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

const { buildApp } = await import("@/app.js");

let app: FastifyInstance;
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
});

let seq = 0;
const doc = (clientId: string, data: Record<string, unknown>) =>
  prisma.invoice.create({
    data: {
      clientId,
      status: InvoiceStatus.ISSUED,
      number: `T-${++seq}`,
      issueDate: new Date(Date.UTC(2026, 8, seq)),
      subtotalCents: 100_000,
      totalCents: 100_000,
      ...data,
    } as never,
  });

/**
 * Client complet : un projet visible né d'un devis (acompte payé par jalon, facture, avoir, abonnement),
 * un projet masqué avec son devis, un devis en attente et une facture hors projet.
 */
async function richClient(name: string) {
  const client = await createClient({ displayName: name });
  const service = await createService({ name: `Maintenance ${name}` });
  const quote = await doc(client.id, {
    documentType: InvoiceDocumentType.QUOTE,
    quoteStatus: QuoteStatus.ACCEPTED,
    lines: {
      create: [
        { position: 1, description: "Site", quantity: 1, unitPriceCents: 100_000, lineTotalCents: 100_000 },
        { position: 2, description: "Maintenance", quantity: 1, unitPriceCents: 5_000, lineTotalCents: 5_000, isSubscription: true, billingDay: 1, billingInterval: "MONTH", serviceId: service.id },
      ],
    },
  });
  const milestone = await prisma.paymentMilestone.create({
    data: { quoteId: quote.id, position: 1, label: "Acompte", percentBps: 3000, amountCents: 30_000, triggerText: "À la signature", status: MilestoneStatus.PAID, paidAt: new Date(Date.UTC(2026, 8, 2)) },
  });
  const deposit = await doc(client.id, { documentType: InvoiceDocumentType.INVOICE, quoteId: quote.id, status: InvoiceStatus.PAID, milestoneId: milestone.id });
  const balance = await doc(client.id, { documentType: InvoiceDocumentType.INVOICE, quoteId: quote.id });
  await prisma.payment.create({ data: { invoiceId: balance.id, amountCents: 20_000, paidAt: new Date(Date.UTC(2026, 8, 20)) } });
  const credit = await doc(client.id, { documentType: InvoiceDocumentType.CREDIT_NOTE, creditedInvoiceId: balance.id, totalCents: 10_000 });
  const project = await prisma.clientProject.create({
    data: { clientId: client.id, name: `Site ${name}`, quoteId: quote.id, status: "ACTIVE", kind: "SITE", startedAt: new Date(Date.UTC(2026, 8, 3)) },
  });
  const quoteLine = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: quote.id, isSubscription: true } });
  const subscription = await prisma.subscription.create({
    data: { clientId: client.id, serviceId: service.id, label: "Maintenance", amountCents: 5_000, billingDay: 1, billingInterval: "MONTH", startDate: new Date(2026, 9, 1), nextInvoiceAt: new Date(2026, 10, 1), sourceLines: { connect: { id: quoteLine.id } } },
  });
  // Abonnement sans ligne d'origine (saisi à la main) : pas de projet.
  const manualSub = await prisma.subscription.create({
    data: { clientId: client.id, serviceId: service.id, label: "Hébergement", amountCents: 2_000, billingDay: 1, billingInterval: "MONTH", startDate: new Date(2026, 9, 1), nextInvoiceAt: new Date(2026, 10, 1) },
  });

  // Projet masqué : ses pièces ne révèlent pas son identifiant.
  const hiddenQuote = await doc(client.id, { documentType: InvoiceDocumentType.QUOTE, quoteStatus: QuoteStatus.ACCEPTED });
  const hidden = await prisma.clientProject.create({ data: { clientId: client.id, name: "Masqué", quoteId: hiddenQuote.id, visibleOnPortal: false } });
  const pendingQuote = await doc(client.id, { documentType: InvoiceDocumentType.QUOTE, quoteStatus: QuoteStatus.SENT });
  const loose = await doc(client.id, { documentType: InvoiceDocumentType.INVOICE });

  const { token } = await openPortalSession({ clientId: client.id, deviceId: `appareil-${client.id}`, ipAddress: "203.0.113.9", userAgent: "Test" });
  return { client, quote, deposit, balance, credit, project, subscription, manualSub, hiddenQuote, hidden, pendingQuote, loose, cookie: `${PORTAL_COOKIE}=${token}` };
}

let ip = 0;
const tracking = async (cookie: string) => {
  const res = await app.inject({ method: "GET", url: "/api/public/tracking", headers: { cookie }, remoteAddress: `10.7.0.${++ip % 250}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};

describe("/api/public/tracking : rattachement aux projets", () => {
  it("pièces, paiements, abonnements et projets portent le projet ; null sans projet visible", async () => {
    const a = await richClient("Alice");
    const t = await tracking(a.cookie);
    const projectOf = Object.fromEntries(t.documents.map((d: { id: string; projectId: string | null }) => [d.id, d.projectId]));
    expect(projectOf).toEqual({
      [a.quote.id]: a.project.id,
      [a.deposit.id]: a.project.id,
      [a.balance.id]: a.project.id,
      [a.credit.id]: a.project.id,
      [a.hiddenQuote.id]: null,
      [a.pendingQuote.id]: null,
      [a.loose.id]: null,
    });

    const items = t.paymentHistory.items as Array<{ id: string; projectId: string | null }>;
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) expect(item.projectId, item.id).toBe(a.project.id);

    const subs = Object.fromEntries(t.subscriptions.map((s: { id: string; projectId: string | null }) => [s.id, s.projectId]));
    expect(subs).toEqual({ [a.subscription.id]: a.project.id, [a.manualSub.id]: null });

    expect(t.projects).toHaveLength(1);
    expect(t.projects[0]).toMatchObject({ id: a.project.id, quoteId: a.quote.id, kind: "SITE", startedAt: "2026-09-03T00:00:00.000Z" });
    expect(JSON.stringify(t)).not.toContain(a.hidden.id);
  });

  it("projet sans devis, sans type ni date : quoteId, kind et startedAt à null", async () => {
    const client = await createClient({ displayName: "Bob" });
    await prisma.clientProject.create({ data: { clientId: client.id, name: "Conseil" } });
    const { token } = await openPortalSession({ clientId: client.id, deviceId: "appareil-bob", ipAddress: "203.0.113.9", userAgent: "Test" });
    const t = await tracking(`${PORTAL_COOKIE}=${token}`);
    expect(t.projects[0]).toMatchObject({ quoteId: null, kind: null, startedAt: null });
  });

  it("isolation : aucune pièce, aucun projet ni abonnement d'un autre client", async () => {
    const a = await richClient("Alice");
    const b = await richClient("Bruno");
    const body = JSON.stringify(await tracking(a.cookie));
    for (const id of [b.client.id, b.quote.id, b.deposit.id, b.balance.id, b.credit.id, b.project.id, b.subscription.id, b.manualSub.id, b.hidden.id, b.hiddenQuote.id, b.pendingQuote.id, b.loose.id]) {
      expect(body).not.toContain(id);
    }
    const tb = await tracking(b.cookie);
    expect(tb.projects.map((p: { id: string }) => p.id)).toEqual([b.project.id]);
    expect(JSON.stringify(tb)).not.toContain(a.project.id);
  });
});
