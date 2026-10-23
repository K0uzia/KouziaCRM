import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionCollectionMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", () => ({
  isSmtpConfigured: vi.fn(async () => true),
}));

vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));

import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { sendDueFirstChargeNotices, sendDueRenewalReminders, sendDueTermEndReminders } from "@/lib/subscriptions/renewal-reminder.js";
import { portalSubscriptionFields } from "@/lib/subscriptions/self-service.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  vi.mocked(mailEnqueue).mockClear();
});

afterEach(async () => {
  await resetDb();
});

/** billed (par défaut) : déjà facturé au moins une fois, comme tout abonnement qui arrive à reconduction. */
async function subscription(data: { billingInterval?: string; startDate?: Date; nextInvoiceAt?: Date; billed?: boolean } = {}) {
  const c = await createClient({ displayName: "Lou Martin" });
  await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt("lou@example.test") } });
  const s = await createService();
  return prisma.subscription.create({
    data: {
      clientId: c.id,
      serviceId: s.id,
      label: "Maintenance annuelle",
      amountCents: 300_000,
      billingDay: 1,
      billingInterval: data.billingInterval ?? "YEAR",
      startDate: data.startDate ?? new Date(2026, 0, 1),
      nextInvoiceAt: data.nextInvoiceAt ?? new Date(2027, 0, 1),
      lastInvoiceId: data.billed === false ? null : "facture-de-la-1re-annee",
    },
  });
}

describe("information annuelle de reconduction (L215-1)", () => {
  it("part une seule fois, 45 jours avant la date limite (la veille du renouvellement)", async () => {
    const sub = await subscription();
    // Renouvellement le 1er janvier 2027, date limite le 31 décembre : envoi à partir du 16 novembre.
    expect(await sendDueRenewalReminders(new Date(2026, 10, 10))).toBe(0);
    expect(await sendDueRenewalReminders(new Date(2026, 10, 20))).toBe(1);
    expect(await sendDueRenewalReminders(new Date(2026, 11, 1))).toBe(0);

    const call = vi.mocked(mailEnqueue).mock.calls[0]![0];
    expect(call.to).toBe("lou@example.test");
    expect(call.subject).toBe("Reconduction de votre abonnement annuel le 1er janvier 2027");
    expect(call.text).toContain("Date limite pour refuser la reconduction : 31 décembre 2026");
    expect(call.text).toContain("refuser cette reconduction, sans frais");
    expect(call.text).toContain("une facture de 3");
    // Encadré apparent dans la version HTML.
    expect(call.html).toMatch(/border:2px solid[^>]*>Date limite pour refuser la reconduction : 31 décembre 2026</);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.renewalReminderSentFor).toEqual(new Date(2027, 0, 1));
  });

  it("date limite réglable : 30 jours avant le renouvellement, envoi 45 jours plus tôt", async () => {
    await prisma.companySettings.updateMany({ data: { nonRenewalNoticeDays: 30 } });
    await subscription();
    // Date limite le 2 décembre 2026 : envoi à partir du 18 octobre.
    expect(await sendDueRenewalReminders(new Date(2026, 9, 15))).toBe(0);
    expect(await sendDueRenewalReminders(new Date(2026, 9, 20))).toBe(1);
    expect(vi.mocked(mailEnqueue).mock.calls[0]![0].text).toContain("reconduction : 2 décembre 2026");
  });

  it("échéance couverte par un engagement : aucune information de reconduction", async () => {
    const sub = await subscription();
    await prisma.subscription.update({ where: { id: sub.id }, data: { commitmentMonths: 36, commitmentEndsAt: new Date(2029, 0, 1) } });
    expect(await sendDueRenewalReminders(new Date(2026, 10, 20))).toBe(0);
  });

  it("repart à l'échéance de l'année suivante", async () => {
    const sub = await subscription();
    await sendDueRenewalReminders(new Date(2026, 10, 20));
    await prisma.subscription.update({ where: { id: sub.id }, data: { nextInvoiceAt: new Date(2028, 0, 1) } });
    expect(await sendDueRenewalReminders(new Date(2027, 10, 20))).toBe(1);
  });

  it("prélèvement Stripe : inclus, avec le lien de gestion de l'abonnement", async () => {
    const sub = await subscription();
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_annuel" },
    });
    expect(await sendDueRenewalReminders(new Date(2026, 10, 20))).toBe(1);
    const call = vi.mocked(mailEnqueue).mock.calls[0]![0];
    expect(call.text).toContain("/api/public/manage/");
    expect(call.text).toContain("le prélèvement de 3");
  });

  it("ignore le mensuel, la 1re échéance, un abonnement qui s'arrête, une résiliation programmée ou un impayé", async () => {
    await subscription({ billingInterval: "MONTH" });
    await subscription({ startDate: new Date(2026, 11, 1) });
    const ending = await subscription();
    await prisma.subscription.update({ where: { id: ending.id }, data: { endDate: new Date(2026, 11, 31) } });
    const cancelling = await subscription();
    await prisma.subscription.update({
      where: { id: cancelling.id },
      data: { collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_fin", stripeCancelAt: new Date(2027, 0, 1) },
    });
    const unpaid = await subscription();
    await prisma.subscription.update({ where: { id: unpaid.id }, data: { status: "PAUSED", stripeStatus: "unpaid" } });
    expect(await sendDueRenewalReminders(new Date(2026, 10, 20))).toBe(0);
    expect(mailEnqueue).not.toHaveBeenCalled();
  });
});

describe("1re échéance différée (ex. une année offerte)", () => {
  // Début le 1er janvier 2026, 1re facture le 1er janvier 2027, jamais facturé.
  const offert = () => subscription({ billed: false });

  it("jamais l'e-mail de reconduction ni de date limite de refus sur /suivi", async () => {
    const sub = await offert();
    for (const jour of [new Date(2026, 9, 20), new Date(2026, 10, 20), new Date(2026, 11, 15)]) {
      expect(await sendDueRenewalReminders(jour)).toBe(0);
    }
    expect(vi.mocked(mailEnqueue).mock.calls.some(([m]) => /Reconduction/.test(m.subject))).toBe(false);
    expect(portalSubscriptionFields(sub, 1, new Date(2026, 10, 20), false)).not.toHaveProperty("renewalDeadline");
    // Le même abonnement, une fois facturé, retrouve sa date limite (garde-fou du test).
    expect(portalSubscriptionFields(sub, 1, new Date(2026, 10, 20), true)).toHaveProperty("renewalDeadline");
  });

  it("avis de 1re facture à J-30, une seule fois", async () => {
    const sub = await offert();
    expect(await sendDueFirstChargeNotices(new Date(2026, 10, 30))).toBe(0);
    expect(await sendDueFirstChargeNotices(new Date(2026, 11, 2))).toBe(1);
    expect(await sendDueFirstChargeNotices(new Date(2026, 11, 10))).toBe(0);
    const call = vi.mocked(mailEnqueue).mock.calls[0]![0];
    expect(call.subject).toBe("Votre abonnement « Maintenance annuelle » : 1re facture le 1er janvier 2027");
    expect(call.text).toContain("La 1re échéance de votre abonnement « Maintenance annuelle », de 3");
    expect(call.text).toContain("Une facture de 3");
    expect(call.text).not.toMatch(/reconduction/i);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).renewalReminderSentFor).toEqual(new Date(2027, 0, 1));
  });

  it("mensuel différé et prélèvement Stripe : « 1er prélèvement », lien de gestion", async () => {
    const sub = await subscription({ billed: false, billingInterval: "MONTH" });
    await prisma.subscription.update({ where: { id: sub.id }, data: { collectionMethod: SubscriptionCollectionMethod.STRIPE, stripeSubscriptionId: "sub_differe" } });
    expect(await sendDueFirstChargeNotices(new Date(2026, 11, 2))).toBe(1);
    const call = vi.mocked(mailEnqueue).mock.calls[0]![0];
    expect(call.subject).toContain("1er prélèvement le 1er janvier 2027");
    expect(call.text).toContain("par mois");
    expect(call.text).toContain("/api/public/manage/");
  });

  it("pas d'avis si la 1re échéance suit le début de près, ni pour un abonnement déjà facturé", async () => {
    await subscription({ billed: false, startDate: new Date(2026, 11, 20) });
    await subscription();
    expect(await sendDueFirstChargeNotices(new Date(2026, 11, 2))).toBe(0);
  });
});

describe("abonnement engagé : rappel avant la date limite de préavis (décision du 23/10/2026)", () => {
  async function engaged(billingInterval: string, commitmentEndsAt: Date) {
    const sub = await subscription({ billingInterval, startDate: new Date(2026, 0, 1), nextInvoiceAt: new Date(2026, 11, 1) });
    return prisma.subscription.update({ where: { id: sub.id }, data: { commitmentMonths: 12, commitmentEndsAt, amountCents: 25_000 } });
  }

  it("tout rythme de paiement : une fois, 45 jours avant la date limite (un mois avant la fin de l'engagement)", async () => {
    const sub = await engaged("MONTH", new Date(2027, 0, 1));
    // Fin le 1er janvier 2027, date limite le 1er décembre 2026 : envoi à partir du 17 octobre.
    expect(await sendDueTermEndReminders(new Date(2026, 9, 10))).toBe(0);
    expect(await sendDueTermEndReminders(new Date(2026, 9, 20))).toBe(1);
    expect(await sendDueTermEndReminders(new Date(2026, 10, 1))).toBe(0);
    const call = vi.mocked(mailEnqueue).mock.calls[0]![0];
    expect(call.subject).toBe("Votre abonnement « Maintenance annuelle » : fin d'engagement le 1er janvier 2027");
    expect(call.text).toContain("Date limite pour demander la non-reconduction : 1er décembre 2026");
    expect((call.text ?? "").replace(/[  ]/g, " ")).toContain("reconduit pour un an au prix en vigueur (actuellement 250,00 € par mois)");
    expect(call.kind).toBe("subscription_term_end");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).renewalReminderSentFor).toEqual(new Date(2027, 0, 1));
    // Pas d'information annuelle ordinaire en plus.
    expect(await sendDueRenewalReminders(new Date(2026, 10, 20))).toBe(0);
  });

  it("année reconduite : rappel de l'échéance suivante ; rien après une demande de non-reconduction", async () => {
    const sub = await engaged("QUARTER", new Date(2026, 0, 1));
    expect(await sendDueTermEndReminders(new Date(2026, 9, 20))).toBe(1);
    expect(vi.mocked(mailEnqueue).mock.calls[0]![0].subject).toBe("Votre abonnement « Maintenance annuelle » : reconduction le 1er janvier 2027");
    await prisma.subscription.update({ where: { id: sub.id }, data: { cancellationRequestedAt: new Date(2026, 9, 21) } });
    expect(await sendDueTermEndReminders(new Date(2027, 9, 20))).toBe(0);
  });

  it("champs de /suivi : période en cours, date limite, effet d'une demande après la date limite", () => {
    const base = {
      status: "ACTIVE" as const, collectionMethod: "STRIPE" as const, stripeSubscriptionId: "sub_x", stripeStatus: "active",
      stripeCancelAt: null, endDate: null, cancellationRequestedAt: null, billingInterval: "MONTH",
      startDate: new Date(2026, 0, 1), nextInvoiceAt: new Date(2026, 11, 1), commitmentEndsAt: new Date(2027, 0, 1),
    };
    expect(portalSubscriptionFields(base, 1, new Date(2026, 11, 1, 12))).toMatchObject({
      manage: "REQUEST",
      currentTermEndsAt: new Date(2027, 0, 1).toISOString(),
      cancelDeadline: new Date(2026, 11, 1).toISOString(),
      nonRenewalEffectiveAt: new Date(2027, 0, 1).toISOString(),
    });
    expect(portalSubscriptionFields(base, 1, new Date(2026, 11, 2))).toMatchObject({
      currentTermEndsAt: new Date(2027, 0, 1).toISOString(),
      nonRenewalEffectiveAt: new Date(2028, 0, 1).toISOString(),
    });
  });
});
