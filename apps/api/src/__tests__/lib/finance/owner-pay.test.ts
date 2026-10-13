import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { computeMonthlyFlows, getOwnerPaySummary } from "@/lib/finance/owner-pay.js";
import { getDashboardSnapshot } from "@/lib/finance/dashboard-service.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await prisma.ownerWithdrawal.deleteMany();
  await prisma.stripePayout.deleteMany();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: { businessStartDate: new Date(2026, 5, 1), cfeAmountCents: 0, urssafPeriodicity: "MONTHLY", urssafDeadlineDay: 15 },
  });
  invalidateCompanySettingsCache();
});
afterEach(async () => {
  await prisma.ownerWithdrawal.deleteMany();
  await prisma.stripePayout.deleteMany();
  await resetDb();
});

async function paidOn(date: Date, cents: number) {
  const client = await createClient();
  const invoice = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.PAID,
      clientId: client.id,
      issueDate: date,
      subtotalCents: cents,
      totalCents: cents,
    },
  });
  await prisma.payment.create({ data: { invoiceId: invoice.id, amountCents: cents, paidAt: date } });
}

const NOW = new Date(2026, 9, 13, 12);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("salaire disponible cumulatif", () => {
  it("rien versé pendant 3 mois : le reste net s'accumule", async () => {
    await paidOn(new Date(2026, 6, 10), 200000);
    await paidOn(new Date(2026, 7, 10), 200000);
    await paidOn(new Date(2026, 8, 10), 200000);
    const flows = await computeMonthlyFlows(NOW);
    expect(flows.map((f) => f.key)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    const net = sum(flows.map((f) => f.resteNetCents));
    expect(net).toBeGreaterThan(0);
    const summary = await getOwnerPaySummary(NOW);
    expect(summary.availableCents).toBe(net);
    expect(summary.paidThisMonthCents).toBe(0);
    // Chaque mois accumule : la courbe ne redescend pas sans retrait.
    expect(flows[3]!.salaireDisponibleCents).toBeGreaterThan(flows[1]!.salaireDisponibleCents);
  });

  it("la moitié retirée au 4e mois : il reste l'autre moitié ; les versements Stripe ne comptent pas", async () => {
    await paidOn(new Date(2026, 6, 10), 200000);
    await paidOn(new Date(2026, 7, 10), 200000);
    await paidOn(new Date(2026, 8, 10), 200000);
    const before = (await getOwnerPaySummary(NOW)).availableCents;
    const half = Math.round(before / 2);
    // 4e mois d'activité encaissée : octobre. Virement pro vers perso, saisi à la main.
    await prisma.ownerWithdrawal.create({ data: { amountCents: half, date: new Date(2026, 9, 2, 12), note: "Virement perso" } });
    // Versements Stripe (demandé depuis l'ERP ou automatique) : ils arrivent sur le compte pro.
    await prisma.stripePayout.create({
      data: { stripePayoutId: "po_erp", amountCents: 10000, status: "paid", requestedByEmail: "a@kouzia.test", requestedAt: new Date(2026, 9, 3) },
    });
    await prisma.stripePayout.create({ data: { stripePayoutId: "po_auto", amountCents: 50000, status: "paid", createdAt: new Date(2026, 9, 4) } });
    const after = await getOwnerPaySummary(NOW);
    expect(after.paidThisMonthCents).toBe(half);
    expect(after.availableCents).toBe(before - half);
    expect(after.flows.at(-1)!.verseCents).toBe(half);
  });

  it("jamais négatif : un retrait supérieur au cumul affiche 0 €", async () => {
    await paidOn(new Date(2026, 6, 10), 100000);
    await prisma.ownerWithdrawal.create({ data: { amountCents: 5_000_000, date: new Date(2026, 9, 2, 12) } });
    expect((await getOwnerPaySummary(NOW)).availableCents).toBe(0);
  });

  it("période URSSAF précédente antérieure au début d'activité : pas de statut", async () => {
    await prisma.companySettings.updateMany({ data: { businessStartDate: new Date(2026, 8, 1) } });
    invalidateCompanySettingsCache();
    const snap = await getDashboardSnapshot("month", null, NOW);
    // Échéance : septembre ; période précédente : août, avant le 1er septembre.
    expect(snap.echeance.periodKey).toBe("2026-09");
    expect(snap.echeance.priorPeriod).toBeNull();
  });
});
