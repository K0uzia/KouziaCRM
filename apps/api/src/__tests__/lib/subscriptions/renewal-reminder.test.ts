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
import { sendDueRenewalReminders } from "@/lib/subscriptions/renewal-reminder.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  vi.mocked(mailEnqueue).mockClear();
});

afterEach(async () => {
  await resetDb();
});

async function subscription(data: { billingInterval?: string; startDate?: Date; nextInvoiceAt?: Date } = {}) {
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
    expect(call.subject).toBe("Reconduction de votre abonnement annuel le 1 janvier 2027");
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
