import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSubscription, generateDueSubscriptionInvoices } from "@/lib/subscriptions/subscription-service.js";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

// Décisions du 27/10/2026 :
// - facture d'abonnement en retard (worker arrêté) : datée du jour de son émission, période facturée indiquée sur la
//   ligne, numérotation dans l'ordre chronologique ;
// - période qui dépasse la fin du contrat : dernière facture au prorata jusqu'à la date de fin.
beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  await resetDb();
});

async function monthly(start: Date, amountCents = 31000) {
  const client = await createClient();
  const service = await createService();
  return createSubscription({ clientId: client.id, serviceId: service.id, label: "Maintenance", amountCents, billingDay: start.getDate(), startDate: start, catchUpPastPeriods: true });
}

const invoicesOf = (subscriptionId: string) =>
  prisma.invoice.findMany({ where: { subscriptionId }, include: { lines: { orderBy: { position: "asc" } } }, orderBy: { sequenceNumber: "asc" } });

const day = (d: Date | null) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : null);

describe("facture d'abonnement en retard", () => {
  it("datée du jour, période sur la ligne, et le cycle suivant n'est pas sauté", async () => {
    const sub = await monthly(new Date(2026, 5, 1));
    const now = new Date(2026, 7, 15, 10, 0, 0);
    // Trois échéances en retard (juin, juillet, août), une par passage.
    expect(await generateDueSubscriptionInvoices(now)).toBe(1);
    expect(await generateDueSubscriptionInvoices(now)).toBe(1);
    expect(await generateDueSubscriptionInvoices(now)).toBe(1);
    expect(await generateDueSubscriptionInvoices(now)).toBe(0);

    const invoices = await invoicesOf(sub.id);
    expect(invoices.map((i) => day(i.issueDate))).toEqual(["2026-08-15", "2026-08-15", "2026-08-15"]);
    expect(invoices.map((i) => i.lines[0]!.description)).toEqual([
      "Maintenance : période du 01/06/2026 au 30/06/2026",
      "Maintenance : période du 01/07/2026 au 31/07/2026",
      "Maintenance : période du 01/08/2026 au 31/08/2026",
    ]);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(day(after.nextInvoiceAt)).toBe("2026-09-01");
  });

  it("à l'heure : datée de l'échéance, libellé seul pour un mensuel", async () => {
    const sub = await monthly(new Date(2026, 5, 1));
    expect(await generateDueSubscriptionInvoices(new Date(2026, 5, 1, 1, 0, 0))).toBe(1);
    const [invoice] = await invoicesOf(sub.id);
    expect(day(invoice!.issueDate)).toBe("2026-06-01");
    expect(invoice!.lines[0]!.description).toBe("Maintenance");
  });
});

describe("dernière période au-delà de la fin du contrat", () => {
  it("facturée au prorata jusqu'à la date de fin", async () => {
    const sub = await monthly(new Date(2026, 6, 1), 31000);
    await prisma.subscription.update({ where: { id: sub.id }, data: { endDate: new Date(2026, 6, 14, 23, 59, 59, 999) } });
    expect(await generateDueSubscriptionInvoices(new Date(2026, 6, 1, 1, 0, 0))).toBe(1);
    const [invoice] = await invoicesOf(sub.id);
    // 14 jours sur 31 : 310 € x 14 / 31 = 140 €.
    expect(invoice!.totalCents).toBe(14000);
    expect(invoice!.lines[0]!.description).toBe("Maintenance : période du 01/07/2026 au 14/07/2026 (prorata : 14 jours sur 31)");
    expect(invoice!.lines[0]!.lineTotalCents).toBe(14000);
  });

  it("fin au dernier jour de la période : tarif plein", async () => {
    const sub = await monthly(new Date(2026, 6, 1), 31000);
    await prisma.subscription.update({ where: { id: sub.id }, data: { endDate: new Date(2026, 6, 31, 23, 59, 59, 999) } });
    expect(await generateDueSubscriptionInvoices(new Date(2026, 6, 1, 1, 0, 0))).toBe(1);
    const [invoice] = await invoicesOf(sub.id);
    expect(invoice!.totalCents).toBe(31000);
  });
});
