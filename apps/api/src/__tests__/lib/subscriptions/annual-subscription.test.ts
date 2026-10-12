import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceDocumentType, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import {
  computeMrrCents,
  createSubscription,
  generateDueSubscriptionInvoices,
  monthlyEquivalentCents,
  resumeSubscription,
  SubscriptionError,
  updateSubscription,
} from "@/lib/subscriptions/subscription-service.js";
import { activateSubscriptionsFromDocument } from "@/lib/subscriptions/activate-from-document.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

async function yearly(opts: { skipCurrentPeriod?: boolean; amountCents?: number } = {}) {
  const c = await createClient();
  const s = await createService();
  return createSubscription({
    clientId: c.id,
    serviceId: s.id,
    label: "Maintenance annuelle",
    amountCents: opts.amountCents ?? 300_000,
    billingDay: 1,
    billingInterval: "YEAR",
    startDate: new Date(2026, 0, 1),
    skipCurrentPeriod: opts.skipCurrentPeriod,
  });
}

describe("abonnement annuel", () => {
  it("1re échéance dans le devis : la suivante tombe 12 mois plus tard", async () => {
    const sub = await yearly({ skipCurrentPeriod: true });
    expect(sub.billingInterval).toBe("YEAR");
    expect(sub.nextInvoiceAt).toEqual(new Date(2027, 0, 1));
  });

  it("facture l'échéance avec la période couverte et avance de 12 mois", async () => {
    const sub = await yearly();
    expect(await generateDueSubscriptionInvoices(new Date(2026, 0, 1, 1))).toBe(1);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextInvoiceAt).toEqual(new Date(2027, 0, 1));
    const inv = await prisma.invoice.findUniqueOrThrow({
      where: { id: after.lastInvoiceId! },
      include: { lines: true },
    });
    expect(inv.totalCents).toBe(300_000);
    expect(inv.paymentTerms).toBe("Échéance annuelle : paiement à réception");
    expect(inv.lines[0]!.description).toBe("Maintenance annuelle : période du 01/01/2026 au 31/12/2026");

    // Rejoué dans l'année : rien de plus.
    expect(await generateDueSubscriptionInvoices(new Date(2026, 5, 1))).toBe(0);
  });

  it("MRR : un montant annuel compte pour 1/12 ; ARR : montants réellement facturés", async () => {
    await yearly({ amountCents: 300_000 });
    const c = await createClient({ displayName: "Mensuel" });
    const s = await createService();
    await createSubscription({
      clientId: c.id,
      serviceId: s.id,
      label: "Maintenance",
      amountCents: 30_000,
      billingDay: 1,
      startDate: new Date(2026, 0, 1),
    });
    const mrr = await computeMrrCents(new Date(2026, 0, 2));
    expect(mrr.mrrCents).toBe(25_000 + 30_000);
    expect(mrr.arrCents).toBe(300_000 + 360_000);
    expect(mrr.bySubscription.find((b) => b.billingInterval === "YEAR")?.monthlyCents).toBe(25_000);
    expect(monthlyEquivalentCents(100, "YEAR")).toBe(8);
  });

  it("un devis avec une ligne annuelle crée un abonnement annuel", async () => {
    const c = await createClient();
    const s = await createService();
    const quote = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE,
        quoteStatus: QuoteStatus.ACCEPTED,
        clientId: c.id,
        subtotalCents: 300_000,
        totalCents: 300_000,
        lines: {
          create: {
            position: 1,
            description: "Maintenance annuelle",
            quantity: 1,
            unitPriceCents: 300_000,
            lineTotalCents: 300_000,
            isSubscription: true,
            billingDay: 5,
            billingInterval: "YEAR",
            serviceId: s.id,
          },
        },
      },
    });
    const res = await activateSubscriptionsFromDocument(quote.id);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: res.subscriptionIds[0]! } });
    expect(sub.billingInterval).toBe("YEAR");
    const months =
      (sub.nextInvoiceAt.getFullYear() - sub.startDate.getFullYear()) * 12 +
      sub.nextInvoiceAt.getMonth() -
      sub.startDate.getMonth();
    expect(months).toBe(12);
  });

  it("changement de périodicité : effet à la prochaine échéance, refusé sous prélèvement Stripe", async () => {
    const sub = await yearly({ skipCurrentPeriod: true });
    const monthly = await updateSubscription(sub.id, { billingInterval: "MONTH", amountCents: 30_000 });
    expect(monthly.billingInterval).toBe("MONTH");
    expect(monthly.nextInvoiceAt).toEqual(sub.nextInvoiceAt);

    await prisma.subscription.update({ where: { id: sub.id }, data: { stripeSubscriptionId: "sub_1" } });
    await expect(updateSubscription(sub.id, { billingInterval: "YEAR" })).rejects.toBeInstanceOf(
      SubscriptionError,
    );
  });
});

describe("reprise après suspension", () => {
  async function paused(nextInvoiceAt: Date, billingDay = 5) {
    const c = await createClient();
    const s = await createService();
    return prisma.subscription.create({
      data: {
        clientId: c.id,
        serviceId: s.id,
        label: "Maintenance",
        amountCents: 2_900,
        billingDay,
        startDate: new Date(2026, 0, 1),
        nextInvoiceAt,
        status: "PAUSED",
      },
    });
  }

  it("échéance encore à venir : inchangée (0 jour de décalage)", async () => {
    const sub = await paused(new Date(2026, 9, 30));
    const resumed = await resumeSubscription(sub.id, new Date(2026, 9, 12, 23));
    expect(resumed.nextInvoiceAt).toEqual(new Date(2026, 9, 30));
  });

  it("échéance passée pendant la suspension : prochaine date de facturation, sans rattrapage", async () => {
    const sub = await paused(new Date(2026, 9, 5));
    const resumed = await resumeSubscription(sub.id, new Date(2026, 10, 20, 10));
    expect(resumed.nextInvoiceAt).toEqual(new Date(2026, 11, 5));
    expect(await generateDueSubscriptionInvoices(new Date(2026, 10, 20, 11))).toBe(0);
  });

  it("reprise le jour même de la date de facturation : facturée aujourd'hui", async () => {
    const sub = await paused(new Date(2026, 9, 5));
    const resumed = await resumeSubscription(sub.id, new Date(2026, 10, 5, 15));
    expect(resumed.nextInvoiceAt).toEqual(new Date(2026, 10, 5));
  });
});
