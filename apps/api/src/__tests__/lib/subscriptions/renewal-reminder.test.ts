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

describe("rappel J-30 du renouvellement annuel", () => {
  it("part une seule fois dans les 30 jours qui précèdent l'échéance", async () => {
    const sub = await subscription();
    expect(await sendDueRenewalReminders(new Date(2026, 10, 15))).toBe(0);
    expect(await sendDueRenewalReminders(new Date(2026, 11, 10))).toBe(1);
    expect(await sendDueRenewalReminders(new Date(2026, 11, 20))).toBe(0);

    const call = vi.mocked(mailEnqueue).mock.calls[0]![0];
    expect(call.to).toBe("lou@example.test");
    expect(call.subject).toBe("Renouvellement de votre abonnement annuel le 1 janvier 2027");
    expect(call.text).toContain("Une facture de 3");
    expect(call.text).toContain("ne souhaitez pas le renouveler");
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.renewalReminderSentFor).toEqual(new Date(2027, 0, 1));
  });

  it("repart à l'échéance de l'année suivante", async () => {
    const sub = await subscription();
    await sendDueRenewalReminders(new Date(2026, 11, 10));
    await prisma.subscription.update({ where: { id: sub.id }, data: { nextInvoiceAt: new Date(2028, 0, 1) } });
    expect(await sendDueRenewalReminders(new Date(2027, 11, 10))).toBe(1);
  });

  it("ignore le mensuel, la 1re échéance, le prélèvement Stripe et un abonnement qui s'arrête", async () => {
    await subscription({ billingInterval: "MONTH" });
    await subscription({ startDate: new Date(2026, 11, 1) });
    const stripe = await subscription();
    await prisma.subscription.update({
      where: { id: stripe.id },
      data: { collectionMethod: SubscriptionCollectionMethod.STRIPE },
    });
    const ending = await subscription();
    await prisma.subscription.update({ where: { id: ending.id }, data: { endDate: new Date(2026, 11, 31) } });
    expect(await sendDueRenewalReminders(new Date(2026, 11, 10))).toBe(0);
    expect(mailEnqueue).not.toHaveBeenCalled();
  });
});
