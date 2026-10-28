import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { formatEUR } from "@/lib/money.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

// Audit des calculs (28/10/2026) : prix du rachat annoncé et montant de la page de prélèvement, contre le montant réellement dû.
vi.mock("@/lib/email/smtp.js", async (orig) => ({ ...(await orig<typeof import("@/lib/email/smtp.js")>()), isSmtpConfigured: vi.fn(async () => true) }));
vi.mock("@/lib/email/mailer/index.js", () => ({ mailEnqueue: vi.fn(async () => ({ outboxId: "o1", messageId: "<x@y>" })) }));

const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { sendDueTermEndReminders } = await import("@/lib/subscriptions/renewal-reminder.js");
const { createBuyoutQuote } = await import("@/lib/subscriptions/buyout.js");
const { payPageInfo } = await import("@/lib/stripe/pay-page.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  vi.mocked(mailEnqueue).mockClear();
});

describe("rachat annoncé dans l'e-mail de fin d'engagement (CGV, article Rachat)", () => {
  it("le prix annoncé est celui du devis de rachat créé le même jour (tarif plein + échéances restant à courir)", async () => {
    const now = new Date(2026, 9, 28, 12);
    const c = await createClient({ displayName: "Asso Les Monts" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt("asso@example.test") } });
    const buyout = await prisma.service.create({ data: { name: "Rachat du site", unitPriceCents: 120_000 } });
    const offer = await prisma.service.create({ data: { name: "Site tout compris", unitPriceCents: 10_000, isSubscription: true, buyoutServiceId: buyout.id } });
    // Mensuel 100 €, engagement jusqu'au 1er janvier 2027 : date limite du préavis le 1er décembre, rappel dans la fenêtre.
    const sub = await prisma.subscription.create({
      data: {
        clientId: c.id,
        serviceId: offer.id,
        label: "Site tout compris : mensuel",
        amountCents: 10_000,
        billingDay: 1,
        billingInterval: "MONTH",
        startDate: new Date(2025, 0, 1),
        commitmentMonths: 24,
        commitmentEndsAt: new Date(2027, 0, 1),
        nextInvoiceAt: new Date(2026, 10, 1),
      },
    });
    expect(await sendDueTermEndReminders(now)).toBe(1);
    const text = vi.mocked(mailEnqueue).mock.calls[0]![0].text as string;
    const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: (await createBuyoutQuote(sub.id, now)).id } });
    // Devis : 1 200 € + 2 échéances restant à courir (novembre, décembre) de 100 € = 1 400 € ; l'e-mail dit le même prix.
    expect(quote.totalCents).toBe(140_000);
    expect(text).toContain(`pour ${formatEUR(quote.totalCents)}`);
  });
});

describe("page de mise en place du prélèvement d'un abonnement remisé", () => {
  it("annonce le montant de la prochaine échéance, remise déduite (comme l'avis de 1re échéance)", async () => {
    const c = await createClient();
    const offer = await prisma.service.create({ data: { name: "Site tout compris", unitPriceCents: 10_000, isSubscription: true } });
    // Remise d'ouverture : 30 % sur les 12 premières échéances de 100 €.
    const sub = await prisma.subscription.create({
      data: {
        clientId: c.id,
        serviceId: offer.id,
        label: "Site tout compris : mensuel",
        amountCents: 10_000,
        billingDay: 1,
        billingInterval: "MONTH",
        startDate: new Date(),
        nextInvoiceAt: new Date(),
        discountKind: "PERCENT",
        discountValue: 3000,
        discountPeriods: 12,
      },
    });
    const info = await payPageInfo("subscribe" as never, sub.id);
    // Stripe prélèvera 70,00 € (coupon) pendant 12 échéances, puis 100,00 €.
    expect(info?.detail).toContain(`Prélèvement de ${formatEUR(7_000)} par mois pendant 12 échéances, puis ${formatEUR(10_000)} par mois`);
  });
});
