import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InvoiceDocumentType, InvoiceStatus, QuoteStatus, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { createSession, hashPassword, SESSION_COOKIE } from "@/lib/auth.js";
import { ensureDefaultLegalClauses } from "@/lib/company/legal-clauses.js";
import { resetDb } from "../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../helpers/factories.js";

// Lot C (audit des abonnements du 25/10/2026) : chaque test reproduit un défaut relevé avant sa correction.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: async () => true,
}));
const { alertAdmin, stripeAction } = vi.hoisted(() => ({
  alertAdmin: vi.fn(async () => undefined),
  stripeAction: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));
vi.mock("@/lib/stripe/subscription-control.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/subscription-control.js")>()),
  applyStripeSubscriptionAction: stripeAction,
}));

const { buildApp } = await import("@/app.js");
const { createBuyoutQuote, buyoutStateOf, currentPeriodEndOf } = await import("@/lib/subscriptions/buyout.js");
const { issueQuote, acceptQuoteByClient } = await import("@/lib/invoices/transitions.js");
const { createSubscription, closeEndedSubscriptions } = await import("@/lib/subscriptions/subscription-service.js");
const { sendDueFirstChargeNotices, sendDueTermEndReminders } = await import("@/lib/subscriptions/renewal-reminder.js");
const { cancellableTermOf } = await import("@/lib/subscriptions/commitment.js");

const ADMIN = "admin-lot-c@kouzia.test";
const DAY = 86_400_000;
let app: FastifyInstance;
let cookie = "";
let clientId = "";

beforeAll(async () => {
  app = await buildApp({ silent: true, serveStatic: false });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await ensureDefaultLegalClauses();
  alertAdmin.mockClear();
  stripeAction.mockReset();
  stripeAction.mockResolvedValue(undefined);
  await prisma.user.deleteMany({ where: { email: ADMIN } });
  const user = await prisma.user.create({ data: { email: ADMIN, passwordHash: await hashPassword("mot-de-passe-de-test") } });
  cookie = `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
  ({ id: clientId } = await createClient({ displayName: "Client des abonnements" }));
  await prisma.client.update({ where: { id: clientId }, data: { emailEncrypted: encrypt("client@exemple.fr") } });
});

/** Offre annuelle avec prestation de rachat, abonnement engagé 36 mois, prochaine échéance dans 6 mois. */
async function boughtOutCandidate(extra: { billingInterval?: string } = {}) {
  const offer = await prisma.service.create({ data: { name: "Vitrine", unitPriceCents: 36_000, isSubscription: true, billingInterval: "YEAR" } });
  const buyout = await prisma.service.create({ data: { name: "Rachat du site Vitrine", unitPriceCents: 75_000 } });
  await prisma.service.update({ where: { id: offer.id }, data: { buyoutServiceId: buyout.id } });
  const next = new Date();
  next.setMonth(next.getMonth() + 6, 1);
  next.setHours(0, 0, 0, 0);
  const sub = await prisma.subscription.create({
    data: {
      clientId, serviceId: offer.id, label: "Vitrine : annuel", amountCents: 36_000, billingDay: 1,
      billingInterval: extra.billingInterval ?? "YEAR", startDate: new Date(next.getFullYear() - 1, next.getMonth(), 1), nextInvoiceAt: next,
      commitmentMonths: 36, commitmentEndsAt: new Date(next.getFullYear() + 2, next.getMonth(), 1),
    },
  });
  return { sub, offer };
}

describe("rachat", () => {
  it("période changée entre le devis et la signature : signature refusée, l'abonnement n'est pas touché", async () => {
    const { sub } = await boughtOutCandidate();
    const { id } = await createBuyoutQuote(sub.id);
    await issueQuote(id);
    // La période en cours est facturée entre-temps : l'échéance avance d'un an.
    const moved = new Date(sub.nextInvoiceAt);
    moved.setFullYear(moved.getFullYear() + 1);
    await prisma.subscription.update({ where: { id: sub.id }, data: { nextInvoiceAt: moved } });
    await expect(acceptQuoteByClient(id, "Lou Martin", { source: "ADMIN" })).rejects.toMatchObject({ code: "EXPIRED" });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.endDate).toBeNull();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).quoteStatus).toBe(QuoteStatus.SENT);
  });

  it("même période : signature acceptée, période figée sur le devis ; la fin attend le paiement du rachat (28/10/2026)", async () => {
    const { sub } = await boughtOutCandidate();
    const { id } = await createBuyoutQuote(sub.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).buyoutPeriodEndsAt?.getTime()).toBe(currentPeriodEndOf(sub).getTime());
    await issueQuote(id);
    await acceptQuoteByClient(id, "Lou Martin", { source: "ADMIN" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).quoteStatus).toBe(QuoteStatus.ACCEPTED);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).endDate).toBeNull();
  });

  async function originalQuote(subId: string, serviceId: string, lines: Array<{ cents: number; interval: string }>) {
    await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.ISSUED, quoteStatus: QuoteStatus.ACCEPTED, number: "D-2026-0300",
        clientId, subtotalCents: 0, totalCents: 0, issueDate: new Date(Date.now() - 400 * DAY), billingMode: "RECURRING",
        lines: {
          create: lines.map((l, i) => ({
            position: i + 1, description: `Ligne ${i + 1}`, quantity: 1, unitPriceCents: l.cents, lineTotalCents: l.cents,
            isSubscription: true, billingInterval: l.interval, subscriptionId: subId, serviceId,
          })),
        },
      },
    });
  }

  it("prix d'une période restante : toutes les lignes d'abonnement du devis d'origine additionnées", async () => {
    const { sub, offer } = await boughtOutCandidate();
    await originalQuote(sub.id, offer.id, [{ cents: 20_000, interval: "YEAR" }, { cents: 16_000, interval: "YEAR" }]);
    const { id } = await createBuyoutQuote(sub.id);
    const remaining = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: id, position: 2 } });
    expect(remaining.unitPriceCents).toBe(36_000);
  });

  it("périodicité changée par avenant : rachat refusé (prix d'origine inapplicable)", async () => {
    const { sub, offer } = await boughtOutCandidate({ billingInterval: "MONTH" });
    await originalQuote(sub.id, offer.id, [{ cents: 36_000, interval: "YEAR" }]);
    const state = await buyoutStateOf(sub.id);
    expect(state?.canPropose).toBe(false);
    await expect(createBuyoutQuote(sub.id)).rejects.toThrow(/périodicité/);
  });
});

describe("rappels", () => {
  /** Engagé, jamais facturé (1re échéance dans 20 jours), fin d'engagement dans 40 jours : les deux avis tombent ensemble. */
  async function overlapping() {
    const service = await createService({ name: "Maintenance", isSubscription: true });
    return prisma.subscription.create({
      data: {
        clientId, serviceId: service.id, label: "Maintenance", amountCents: 30_000, billingDay: 1, billingInterval: "YEAR",
        startDate: new Date(Date.now() - 60 * DAY), nextInvoiceAt: new Date(Date.now() + 20 * DAY),
        commitmentMonths: 12, commitmentEndsAt: new Date(Date.now() + 40 * DAY),
      },
    });
  }

  it("avis de 1re échéance et rappel de fin de période qui se chevauchent : chacun part une fois, pas de renvoi chaque heure", async () => {
    await overlapping();
    expect(await sendDueFirstChargeNotices()).toBe(1);
    expect(await sendDueTermEndReminders()).toBe(1);
    expect(await sendDueFirstChargeNotices()).toBe(0);
    expect(await sendDueTermEndReminders()).toBe(0);
  });

  it("reprise de la migration : un avis de 1re échéance déjà envoyé (ancien marqueur) ne repart pas", async () => {
    const sub = await overlapping();
    await prisma.subscription.update({ where: { id: sub.id }, data: { renewalReminderSentFor: sub.nextInvoiceAt, firstChargeNoticeSentFor: null } });
    const sql = readFileSync(fileURLToPath(new URL("../../../../../prisma/migrations/20261213090000_abonnements_c/migration.sql", import.meta.url)), "utf8");
    const update = sql.split(";").map((s) => s.replace(/^\s*--.*$/gm, "").trim()).find((s) => s.startsWith("UPDATE"))!;
    await prisma.$executeRawUnsafe(update);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).firstChargeNoticeSentFor?.getTime()).toBe(sub.nextInvoiceAt.getTime());
    expect(await sendDueFirstChargeNotices()).toBe(0);
  });
});

describe("fin programmée et clôture", () => {
  async function engaged(extra: { stripeSubscriptionId?: string } = {}) {
    const service = await createService({ name: "Maintenance", isSubscription: true });
    const commitmentEndsAt = new Date();
    commitmentEndsAt.setMonth(commitmentEndsAt.getMonth() + 8, 1);
    commitmentEndsAt.setHours(0, 0, 0, 0);
    return prisma.subscription.create({
      data: {
        clientId, serviceId: service.id, label: "Maintenance", amountCents: 3_000, billingDay: 1, billingInterval: "MONTH",
        startDate: new Date(Date.now() - 120 * DAY), nextInvoiceAt: new Date(Date.now() + 10 * DAY), commitmentMonths: 12, commitmentEndsAt,
        ...(extra.stripeSubscriptionId ? { stripeSubscriptionId: extra.stripeSubscriptionId, collectionMethod: "STRIPE", stripeLivemode: false } : {}),
      },
    });
  }

  it("« Programmer la fin » : fin au dernier instant du terme, abonnement toujours actif ; sous Stripe, arrêt programmé à cette date", async () => {
    const sub = await engaged({ stripeSubscriptionId: "sub_test_c" });
    const term = cancellableTermOf(sub.commitmentEndsAt!);
    const res = await app.inject({ method: "POST", url: `/api/subscriptions/${sub.id}/schedule-end`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe(SubscriptionStatus.ACTIVE);
    expect(after.endDate?.getTime()).toBe(term.termEndsAt.getTime() - 1);
    expect(after.stripeCancelAt?.getTime()).toBe(term.termEndsAt.getTime());
    expect(stripeAction).toHaveBeenCalledWith("sub_test_c", "cancelAt", false, term.termEndsAt);
  });

  it("worker : tout abonnement dont la fin programmée est passée est clôturé, pas seulement un rachat", async () => {
    const sub = await engaged();
    await prisma.subscription.update({ where: { id: sub.id }, data: { endDate: new Date(Date.now() - DAY) } });
    expect(await closeEndedSubscriptions()).toBe(1);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(SubscriptionStatus.ENDED);
  });
});

describe("date de début passée", () => {
  it("1re échéance à partir d'aujourd'hui, pas une facture antidatée par période passée ; rattrapage seulement sur demande", async () => {
    const service = await createService({ name: "Maintenance", isSubscription: true });
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const base = { clientId, serviceId: service.id, label: "Maintenance", amountCents: 3_000, billingDay: 1, billingInterval: "MONTH" as const, startDate: twoYearsAgo };
    const sub = await createSubscription(base);
    expect(sub.nextInvoiceAt.getTime()).toBeGreaterThanOrEqual(today.getTime());
    const catchUp = await createSubscription({ ...base, catchUpPastPeriods: true });
    expect(catchUp.nextInvoiceAt.getTime()).toBeLessThan(today.getTime());
  });
});
