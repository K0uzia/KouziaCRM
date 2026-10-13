import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { InvoiceStatus, SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));
vi.mock("@/lib/email/send-document-pdf.js", () => ({ sendDocumentPdf: vi.fn(async () => undefined) }));
const stripeInvoicesRetrieve = vi.fn(async (_id: string): Promise<unknown> => ({ status: "open" }));
const stripeSubsRetrieve = vi.fn(async (_id: string, _p?: unknown): Promise<unknown> => ({ metadata: {} }));
vi.mock("@/lib/email/smtp.js", () => ({ isSmtpConfigured: vi.fn(async () => true) }));
vi.mock("@/lib/stripe/client.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/stripe/client.js")>()),
  getStripe: vi.fn(async () => ({
    paymentIntents: { retrieve: vi.fn(async (id: string) => ({ id, latest_charge: null })) },
    subscriptions: { retrieve: stripeSubsRetrieve },
    invoices: { retrieve: stripeInvoicesRetrieve },
  })),
  getStripeConfig: vi.fn(async () => ({ secretKey: "sk_test_x", webhookSecret: null, mode: "test", enabled: true })),
}));

const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { processStripeEvent } = await import("@/lib/stripe/webhook-handlers.js");
const { issueErpInvoiceFromStripeInvoice } = await import("@/lib/stripe/billing.js");
const { scheduleReminders, listPendingReminders } = await import("@/lib/reminders.js");
const { sendDueActionReminders } = await import("@/lib/subscriptions/dunning.js");
const { checkExpiringCards, cardExpiresAt, cardNeedsNotice } = await import("@/lib/subscriptions/card-expiry.js");

const ADMIN = "admin@kouzia.test";
const CLIENT = "lou@example.test";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: { email: ADMIN, moduleStripeEnabled: true, stripeSecretKeyEncrypted: encrypt("sk_test_fake") },
  });
  stripeInvoicesRetrieve.mockReset().mockResolvedValue({ status: "open" });
  stripeSubsRetrieve.mockReset().mockResolvedValue({ metadata: {} });
  invalidateCompanySettingsCache();
  vi.mocked(mailEnqueue).mockClear();
});
afterEach(async () => {
  await resetDb();
});

async function stripeSubscription() {
  const c = await createClient({ displayName: "Lou Martin" });
  await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt(CLIENT) } });
  const s = await createService();
  return prisma.subscription.create({
    data: {
      clientId: c.id,
      serviceId: s.id,
      label: "Maintenance",
      amountCents: 4_900,
      billingDay: 1,
      billingInterval: "MONTH",
      startDate: new Date(2026, 0, 1),
      nextInvoiceAt: new Date(2026, 9, 1),
      collectionMethod: SubscriptionCollectionMethod.STRIPE,
      stripeSubscriptionId: "sub_dunning",
    },
  });
}

function stripeInvoice(patch: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "in_dunning",
    livemode: false,
    amount_due: 4_900,
    amount_paid: 0,
    total: 4_900,
    attempt_count: 1,
    next_payment_attempt: null,
    billing_reason: "subscription_cycle",
    parent: { subscription_details: { subscription: "sub_dunning" } },
    lines: { data: [{ period: { start: now, end: now + 30 * 86_400 } }] },
    payments: { data: [] },
    ...patch,
  } as unknown as Stripe.Invoice;
}

let eventSeq = 0;
function event(type: string, object: unknown): Stripe.Event {
  eventSeq += 1;
  return { id: `evt_dunning_${eventSeq}`, type, livemode: false, data: { object } } as unknown as Stripe.Event;
}

const sentTo = (to: string) => vi.mocked(mailEnqueue).mock.calls.map((c) => c[0]).filter((m) => m.to === to);

describe("factures miroir Stripe : jamais de relance de l'ERP", () => {
  it("émise sans prochaine relance, ignorée par la planification et la liste des relances", async () => {
    await stripeSubscription();
    const { invoiceId } = await issueErpInvoiceFromStripeInvoice(stripeInvoice());
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).nextReminderAt).toBeNull();

    const later = new Date(Date.now() + 60 * 86_400_000);
    await scheduleReminders(later);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).nextReminderAt).toBeNull();

    // Facture miroir émise avant le correctif, avec une date de relance déjà posée.
    await prisma.invoice.update({ where: { id: invoiceId }, data: { nextReminderAt: new Date(2026, 0, 1) } });
    expect((await listPendingReminders(later)).map((i) => i.id)).not.toContain(invoiceId);
  });
});

describe("échec de prélèvement (invoice.payment_failed)", () => {
  it("1er échec avec nouvelle tentative : e-mail client avec la date et le lien, alerte admin", async () => {
    await stripeSubscription();
    const retry = Math.floor(new Date(2026, 9, 20, 12).getTime() / 1000);
    const res = await processStripeEvent(event("invoice.payment_failed", stripeInvoice({ next_payment_attempt: retry })));
    expect(res.handled).toContain("échec signalé (tentative 1)");

    const [mail] = sentTo(CLIENT);
    expect(mail!.subject).toBe("Prélèvement non abouti : Maintenance");
    expect(mail!.text).toContain("Le prélèvement de 49,00");
    expect(mail!.text).toContain("Une nouvelle tentative aura lieu le 20 octobre 2026");
    expect(mail!.text).toContain("/api/public/manage/");
    expect(mail!.kind).toBe("subscription_payment_failed");
    expect(sentTo(ADMIN)).toHaveLength(1);
  });

  it("SEPA sans nouvelle tentative : aucune promesse, invitation à régulariser", async () => {
    await stripeSubscription();
    await processStripeEvent(event("invoice.payment_failed", stripeInvoice()));
    const [mail] = sentTo(CLIENT);
    expect(mail!.text).toContain("Aucune nouvelle tentative automatique n'est prévue");
    expect(mail!.text).not.toContain("nouvelle tentative aura lieu");
  });

  it("un e-mail par tentative : la même tentative relivrée n'en renvoie pas", async () => {
    await stripeSubscription();
    await processStripeEvent(event("invoice.payment_failed", stripeInvoice({ next_payment_attempt: 1_900_000_000 })));
    const replay = await processStripeEvent(event("invoice.payment_failed", stripeInvoice({ next_payment_attempt: 1_900_000_000 })));
    expect(replay.handled).toContain("échec déjà signalé");
    await processStripeEvent(event("invoice.payment_failed", stripeInvoice({ attempt_count: 2 })));
    expect(sentTo(CLIENT)).toHaveLength(2);
  });

  it("payée après l'échec : e-mail de régularisation, une seule fois ; payée sans échec : rien", async () => {
    await stripeSubscription();
    await processStripeEvent(event("invoice.payment_failed", stripeInvoice()));
    const paid = stripeInvoice({ amount_paid: 4_900, status: "paid" } as Partial<Stripe.Invoice>);
    const res = await processStripeEvent(event("invoice.paid", paid));
    expect(res.handled).toContain("régularisation signalée");
    await processStripeEvent(event("invoice.paid", paid));
    const mails = sentTo(CLIENT).filter((m) => m.kind === "subscription_payment_recovered");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe("Paiement reçu, merci : Maintenance");

    vi.mocked(mailEnqueue).mockClear();
    await processStripeEvent(event("invoice.paid", stripeInvoice({ id: "in_sans_echec", amount_paid: 4_900 })));
    expect(sentTo(CLIENT).filter((m) => m.kind === "subscription_payment_recovered")).toHaveLength(0);
  });
});

describe("abonnement impayé, résiliation programmée", () => {
  function stripeSub(sub: { id: string }, patch: Record<string, unknown>) {
    return {
      id: "sub_dunning",
      status: "active",
      livemode: false,
      pause_collection: null,
      metadata: { erpSubscriptionId: sub.id },
      items: { data: [{ current_period_end: 1_800_000_000, price: { unit_amount: 4_900, recurring: { interval: "month" } } }] },
      ...patch,
    };
  }

  it("unpaid : suspendu dans l'ERP, e-mail client avec le lien, alerte admin ; retour à active : repris", async () => {
    const sub = await stripeSubscription();
    await processStripeEvent(event("customer.subscription.updated", stripeSub(sub, { status: "past_due" })));
    expect(sentTo(CLIENT)).toHaveLength(0);
    await processStripeEvent(event("customer.subscription.updated", stripeSub(sub, { status: "unpaid" })));
    expect(await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({
      status: SubscriptionStatus.PAUSED,
      stripeStatus: "unpaid",
    });
    const [mail] = sentTo(CLIENT);
    expect(mail!.subject).toBe("Abonnement suspendu faute de paiement : Maintenance");
    expect(mail!.text).toContain("/api/public/manage/");
    expect(sentTo(ADMIN).at(-1)!.subject).toContain("Abonnement suspendu depuis Stripe");

    await processStripeEvent(event("customer.subscription.updated", stripeSub(sub, { status: "active" })));
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(SubscriptionStatus.ACTIVE);
    expect(sentTo(CLIENT)).toHaveLength(1);
  });

  it("résiliation en fin de période (portail) : accusé au client et alerte admin, une fois", async () => {
    const sub = await stripeSubscription();
    const scheduled = stripeSub(sub, { cancel_at_period_end: true, cancel_at: 1_800_000_000 });
    await processStripeEvent(event("customer.subscription.updated", scheduled));
    await processStripeEvent(event("customer.subscription.updated", scheduled));
    const acks = sentTo(CLIENT).filter((m) => m.kind === "subscription_cancel_scheduled");
    expect(acks).toHaveLength(1);
    expect(acks[0]!.text).toContain("Cet e-mail vaut accusé de réception");
    expect(sentTo(ADMIN).filter((m) => m.subject.startsWith("Résiliation programmée"))).toHaveLength(1);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).stripeCancelAt).toEqual(
      new Date(1_800_000_000 * 1000),
    );

    await processStripeEvent(event("customer.subscription.updated", stripeSub(sub, {})));
    expect(sentTo(CLIENT).filter((m) => m.kind === "subscription_cancel_revoked")).toHaveLength(1);
  });
});

describe("facture non recouvrable (invoice.marked_uncollectible)", () => {
  it("reste émise et impayée, notée, sans relance, alerte admin", async () => {
    await stripeSubscription();
    const { invoiceId } = await issueErpInvoiceFromStripeInvoice(stripeInvoice());
    await processStripeEvent(event("invoice.marked_uncollectible", stripeInvoice({ status: "uncollectible" } as Partial<Stripe.Invoice>)));
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv.status).toBe(InvoiceStatus.ISSUED);
    expect(inv.stripeUncollectibleAt).toBeInstanceOf(Date);
    expect(inv.nextReminderAt).toBeNull();
    expect(sentTo(ADMIN).at(-1)!.subject).toContain("non recouvrable");
    expect(sentTo(CLIENT)).toHaveLength(0);
  });
});

describe("confirmation de paiement requise (3DS)", () => {
  const HOSTED = "https://invoice.stripe.com/i/acct_1/test_3ds";

  it("e-mail avec la page Stripe, une fois ; rappels J+3, J+5, J+7 puis plus rien", async () => {
    await stripeSubscription();
    const action = stripeInvoice({ hosted_invoice_url: HOSTED } as Partial<Stripe.Invoice>);
    const res = await processStripeEvent(event("invoice.payment_action_required", action));
    expect(res.handled).toContain("confirmation demandée");
    await processStripeEvent(event("invoice.payment_action_required", action));
    const [first] = sentTo(CLIENT);
    expect(sentTo(CLIENT)).toHaveLength(1);
    expect(first!.subject).toBe("Confirmation de paiement requise : Maintenance");
    expect(first!.text).toContain(HOSTED);

    // L'échec qui accompagne la demande de confirmation ne double pas l'e-mail du client.
    await processStripeEvent(event("invoice.payment_failed", action));
    expect(sentTo(CLIENT)).toHaveLength(1);

    const day = (n: number) => new Date(Date.now() + n * 86_400_000 + 60_000);
    expect(await sendDueActionReminders(day(1))).toBe(0);
    expect(await sendDueActionReminders(day(3))).toBe(1);
    expect(await sendDueActionReminders(day(3))).toBe(0);
    expect(await sendDueActionReminders(day(5))).toBe(1);
    expect(await sendDueActionReminders(day(7))).toBe(1);
    expect(await sendDueActionReminders(day(9))).toBe(0);
    const reminders = sentTo(CLIENT).filter((m) => m.kind === "subscription_action_reminder");
    expect(reminders).toHaveLength(3);
    expect(reminders[0]!.subject).toBe("Rappel : confirmation de paiement requise : Maintenance");
  });

  it("facture payée entre-temps chez Stripe : plus de rappel", async () => {
    await stripeSubscription();
    await processStripeEvent(event("invoice.payment_action_required", stripeInvoice({ hosted_invoice_url: HOSTED } as Partial<Stripe.Invoice>)));
    stripeInvoicesRetrieve.mockResolvedValue({ status: "paid" });
    expect(await sendDueActionReminders(new Date(Date.now() + 4 * 86_400_000))).toBe(0);
    stripeInvoicesRetrieve.mockResolvedValue({ status: "open" });
    expect(await sendDueActionReminders(new Date(Date.now() + 8 * 86_400_000))).toBe(0);
  });
});

describe("carte qui expire", () => {
  function card(expMonth: number, expYear: number, id = "pm_card_1") {
    return {
      default_payment_method: { id, type: "card", card: { exp_month: expMonth, exp_year: expYear, last4: "4242", brand: "visa" } },
      customer: "cus_1",
    };
  }

  it("règle : invalide avant la prochaine échéance ou dans le mois", () => {
    const now = new Date(2026, 9, 13);
    expect(cardExpiresAt(10, 2026)).toEqual(new Date(2026, 10, 1));
    expect(cardNeedsNotice(cardExpiresAt(10, 2026), new Date(2027, 0, 1), now)).toBe(true);
    expect(cardNeedsNotice(cardExpiresAt(3, 2027), new Date(2026, 10, 1), now)).toBe(false);
    expect(cardNeedsNotice(cardExpiresAt(3, 2027), new Date(2027, 5, 1), now)).toBe(true);
  });

  it("un e-mail par carte et par date d'expiration, vérifié une fois par mois ; SEPA ignoré", async () => {
    const now = new Date();
    const sub = await stripeSubscription();
    await prisma.subscription.update({ where: { id: sub.id }, data: { nextInvoiceAt: new Date(now.getTime() + 20 * 86_400_000) } });
    stripeSubsRetrieve.mockResolvedValue(card(now.getMonth() + 1, now.getFullYear()));
    expect(await checkExpiringCards(now)).toBe(1);
    const [mail] = sentTo(CLIENT);
    expect(mail!.subject).toBe("Votre carte expire bientôt : Maintenance");
    expect(mail!.text).toContain("VISA se terminant par 4242");
    expect(mail!.text).toContain("/api/public/manage/");

    // Même mois : pas revérifié. Un mois plus tard, même carte : pas de second e-mail.
    expect(await checkExpiringCards(now)).toBe(0);
    expect(await checkExpiringCards(new Date(now.getTime() + 31 * 86_400_000))).toBe(0);
    expect(stripeSubsRetrieve).toHaveBeenCalledTimes(2);

    // Nouvelle carte qui expire aussi : nouvel e-mail.
    stripeSubsRetrieve.mockResolvedValue(card(now.getMonth() + 1, now.getFullYear(), "pm_card_2"));
    expect(await checkExpiringCards(new Date(now.getTime() + 62 * 86_400_000))).toBe(1);

    await prisma.subscription.update({ where: { id: sub.id }, data: { cardCheckedAt: null, cardExpiryNoticeFor: null } });
    stripeSubsRetrieve.mockResolvedValue({ default_payment_method: { id: "pm_sepa", type: "sepa_debit" }, customer: "cus_1" });
    expect(await checkExpiringCards(now)).toBe(0);
  });
});
