/**
 * Audit abonnements du 28/10/2026 (branche audit/abos), devenu test de non-régression : clauses imprimées contre les
 * CGV, article L215-1 (information de reconduction absente ou tardive), fin programmée annulée dans Stripe, avis de
 * 1re échéance d'un abonnement engagé.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegalClauseKind, SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

const mailEnqueue = vi.fn(async (..._args: unknown[]) => ({ queued: true }));
vi.mock("@/lib/email/mailer/index.js", async (orig) => ({ ...(await orig<object>()), mailEnqueue }));
vi.mock("@/lib/email/smtp.js", async (orig) => ({ ...(await orig<object>()), isSmtpConfigured: async () => true }));
const alertAdmin = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));
vi.mock("@/lib/stripe/portal.js", async (orig) => ({
  ...(await orig<object>()),
  subscriptionPaymentUrl: async () => "https://erp.test/api/public/manage/tok",
}));

const { DEFAULT_LEGAL_CLAUSES } = await import("@/lib/company/legal-clauses.js");
const { getCompanySettings, invalidateCompanySettingsCache } = await import("@/lib/company.js");
const { nonRenewalDeadline, sendDueFirstChargeNotices } = await import("@/lib/subscriptions/renewal-reminder.js");
const { cancellableTermOf, commitmentEndOf } = await import("@/lib/subscriptions/commitment.js");
const { portalSubscriptionFields, requestSubscriptionCancellation } = await import("@/lib/subscriptions/self-service.js");
const { syncSubscriptionFromStripe } = await import("@/lib/stripe/billing.js");
const { closeEndedSubscriptions, scheduleSubscriptionEnd } = await import("@/lib/subscriptions/subscription-service.js");
const { encrypt } = await import("@/lib/crypto.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  invalidateCompanySettingsCache();
  mailEnqueue.mockClear();
  alertAdmin.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

async function stripeSub(extra: Partial<Parameters<typeof prisma.subscription.create>[0]["data"]> = {}) {
  const client = await createClient({ displayName: "Asso Audit", type: "ASSOCIATION" });
  const service = await createService({ name: "Site vitrine tout compris", unitPriceCents: 150_000 });
  return prisma.subscription.create({
    data: {
      clientId: client.id,
      serviceId: service.id,
      label: "Site vitrine tout compris",
      amountCents: 150_000,
      billingDay: 1,
      billingInterval: "YEAR",
      startDate: new Date(2026, 9, 1),
      nextInvoiceAt: new Date(2027, 9, 1),
      status: SubscriptionStatus.ACTIVE,
      collectionMethod: SubscriptionCollectionMethod.STRIPE,
      stripeSubscriptionId: "sub_audit",
      stripeLivemode: false,
      ...extra,
    } as Parameters<typeof prisma.subscription.create>[0]["data"],
  });
}

describe("clauses imprimées sur le devis contre les CGV (préavis d'un mois)", () => {
  it("une seule clause « Abonnement avec engagement » active : préavis d'un mois, tout rythme, sans mention de brouillon", () => {
    const active = DEFAULT_LEGAL_CLAUSES.filter((c) => c.kind === LegalClauseKind.SUBSCRIPTION_COMMITMENT && c.active !== false);
    expect(active).toHaveLength(1);
    const body = active[0]!.body;
    expect(body).not.toMatch(/veille/);
    expect(body).toMatch(/un mois/);
    expect(body).not.toMatch(/\[BROUILLON|\[À FAIRE VALIDER/);
    expect(body).not.toMatch(/payable d'avance chaque année/);
    // Option retenue sur un devis payé une fois : engagement depuis la livraison (CGV du 28/10/2026).
    expect(body).toContain("à compter de la livraison");
  });

  it("clauses de périodicité alignées : plus de « résiliable à tout moment », plus de « veille », plus de brouillon", () => {
    for (const kind of [LegalClauseKind.SUBSCRIPTION_MONTHLY, LegalClauseKind.SUBSCRIPTION_QUARTERLY, LegalClauseKind.SUBSCRIPTION_ANNUAL]) {
      const body = DEFAULT_LEGAL_CLAUSES.find((c) => c.kind === kind)!.body;
      expect(body).not.toMatch(/veille|Résiliable à tout moment|\[BROUILLON/);
      expect(body).toMatch(/au plus tard un mois avant/);
    }
  });

  it("annuel sans engagement : la date limite de non-reconduction (réglage par défaut) est au moins un mois avant le renouvellement", async () => {
    const settings = await getCompanySettings();
    const renewal = new Date(2027, 9, 1);
    const deadline = nonRenewalDeadline(renewal, settings.nonRenewalNoticeDays);
    expect(deadline.getTime()).toBeLessThanOrEqual(commitmentEndOf(renewal, -1).getTime());
  });
});

describe("L215-1 : information de reconduction non faite ou tardive", () => {
  const now = new Date(2026, 9, 28);
  const commitmentEndsAt = new Date(2026, 8, 1); // reconduit le 1er septembre 2026
  const paidPeriodEndsAt = new Date(2026, 10, 1); // mensuel : période payée jusqu'au 1er novembre
  const notice = (over: Partial<{ nonProfessional: boolean; renewalReminderSentFor: Date | null; renewalReminderSentAt: Date | null }> = {}) => ({
    nonProfessional: true,
    renewalReminderSentFor: null,
    renewalReminderSentAt: null,
    paidPeriodEndsAt,
    ...over,
  });

  it("aucun avis : le client non professionnel met fin à tout moment, à la fin de la période déjà payée", () => {
    const term = cancellableTermOf(commitmentEndsAt, now, notice());
    expect(term.freeTermination).toBe(true);
    expect(term.termEndsAt).toEqual(paidPeriodEndsAt);
  });

  it("avis envoyé moins d'un mois avant la date limite : même effet", () => {
    // Date limite le 1er août 2026 ; avis parti le 15 juillet (trop tard).
    const term = cancellableTermOf(commitmentEndsAt, now, notice({ renewalReminderSentFor: commitmentEndsAt, renewalReminderSentAt: new Date(2026, 6, 15) }));
    expect(term.freeTermination).toBe(true);
  });

  it("avis envoyé à temps, ou client professionnel : fin de l'année reconduite, préavis d'un mois", () => {
    const onTime = cancellableTermOf(commitmentEndsAt, now, notice({ renewalReminderSentFor: commitmentEndsAt, renewalReminderSentAt: new Date(2026, 5, 15) }));
    expect(onTime.freeTermination).toBeUndefined();
    expect(onTime.termEndsAt).toEqual(commitmentEndOf(commitmentEndsAt, 12));
    expect(cancellableTermOf(commitmentEndsAt, now, notice({ nonProfessional: false })).termEndsAt).toEqual(commitmentEndOf(commitmentEndsAt, 12));
  });

  it("pendant l'engagement : rien ne change", () => {
    const engagedUntil = new Date(2027, 8, 1);
    expect(cancellableTermOf(engagedUntil, now, notice()).termEndsAt).toEqual(engagedUntil);
  });

  it("/suivi : date d'effet = fin de la période payée, freeTermination", () => {
    const f = portalSubscriptionFields(
      {
        status: "ACTIVE",
        collectionMethod: "MANUAL_TRANSFER",
        stripeSubscriptionId: null,
        stripeStatus: null,
        stripeCancelAt: null,
        endDate: null,
        cancellationRequestedAt: null,
        billingInterval: "MONTH",
        startDate: new Date(2023, 8, 1),
        nextInvoiceAt: paidPeriodEndsAt,
        commitmentEndsAt,
        renewalReminderSentFor: null,
        renewalReminderSentAt: null,
      },
      1,
      now,
      true,
      "ASSOCIATION",
    );
    expect(f.nonRenewalEffectiveAt).toBe(paidPeriodEndsAt.toISOString());
    expect(f.freeTermination).toBe(true);
  });

  it("demande depuis /suivi : accusé et alerte disent la fin libre ; « Programmer la fin » prend la même date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const sub = await stripeSub({
      collectionMethod: SubscriptionCollectionMethod.MANUAL_TRANSFER,
      stripeSubscriptionId: null,
      billingInterval: "MONTH",
      startDate: new Date(2025, 8, 1),
      nextInvoiceAt: paidPeriodEndsAt,
      commitmentMonths: 12,
      commitmentEndsAt,
    });
    await prisma.client.updateMany({ data: { emailEncrypted: encrypt("asso@exemple.test") } });
    await requestSubscriptionCancellation(sub.id, now);
    const ack = mailEnqueue.mock.calls.map((c) => c[0] as { subject: string; text: string }).find((m) => /Demande de résiliation reçue/.test(m.subject))!;
    expect(ack.text).toContain("à la fin de la période déjà payée");
    expect(ack.text).toContain("L215-1");
    expect(String(alertAdmin.mock.calls[0]![1])).toContain("L215-1");
    const scheduled = await scheduleSubscriptionEnd(sub.id, now);
    expect(scheduled.endDate!.getTime()).toBe(paidPeriodEndsAt.getTime() - 1);
  });
});

describe("résiliation programmée puis annulée dans Stripe", () => {
  it("cancel_at retiré dans Stripe : l'ERP efface aussi sa date de fin et ne clôture pas un abonnement que Stripe prélève encore", async () => {
    const termEnd = new Date(2027, 9, 1);
    const sub = await stripeSub({ endDate: new Date(termEnd.getTime() - 1), stripeCancelAt: termEnd });
    const result = await syncSubscriptionFromStripe({
      id: "sub_audit",
      object: "subscription",
      status: "active",
      livemode: false,
      cancel_at: null,
      cancel_at_period_end: false,
      pause_collection: null,
      metadata: { erpSubscriptionId: sub.id },
      items: { data: [{ price: { unit_amount: 150_000, recurring: { interval: "year", interval_count: 1 } }, current_period_end: Math.floor(termEnd.getTime() / 1000) }] },
    } as unknown as Stripe.Subscription);
    expect(result?.cancelRevoked).toBe(true);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.endDate).toBeNull();
    await closeEndedSubscriptions(new Date(2027, 9, 2));
    const later = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(later.status).toBe(SubscriptionStatus.ACTIVE);
  });

  it("événement Stripe sur un abonnement déjà clôturé : sa date de fin ne bouge pas", async () => {
    const closedAt = new Date(2026, 8, 15);
    const sub = await stripeSub({ status: SubscriptionStatus.ENDED, endDate: closedAt });
    await syncSubscriptionFromStripe({
      id: "sub_audit",
      object: "subscription",
      status: "canceled",
      ended_at: Math.floor(Date.now() / 1000),
      livemode: false,
      cancel_at: null,
      cancel_at_period_end: false,
      pause_collection: null,
      metadata: { erpSubscriptionId: sub.id },
      items: { data: [{ price: { unit_amount: 150_000, recurring: { interval: "year", interval_count: 1 } } }] },
    } as unknown as Stripe.Subscription);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).endDate).toEqual(closedAt);
  });
});

describe("avis de 1re échéance d'un abonnement engagé prélevé par Stripe", () => {
  it("ne propose pas de « résilier » depuis l'espace de gestion (portail sans résiliation pendant l'engagement)", async () => {
    const now = new Date();
    await stripeSub({
      billingInterval: "MONTH",
      startDate: new Date(now.getTime() - 15 * 86_400_000),
      nextInvoiceAt: new Date(now.getTime() + 20 * 86_400_000),
      commitmentMonths: 36,
      commitmentEndsAt: commitmentEndOf(now, 36),
    });
    await prisma.client.updateMany({ data: { emailEncrypted: encrypt("asso@exemple.test") } });
    expect(await sendDueFirstChargeNotices(now)).toBe(1);
    const mail = mailEnqueue.mock.calls[0]![0] as { text: string };
    expect(mail.text).not.toMatch(/résilier/i);
    expect(mail.text).toContain("changer de moyen de paiement");
  });
});
