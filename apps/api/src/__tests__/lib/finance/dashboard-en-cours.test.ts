import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { getDashboardSnapshot } from "@/lib/finance/dashboard-service.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: { urssafPeriodicity: "MONTHLY", urssafDeadlineDay: 15, businessStartDate: new Date(2026, 8, 1) },
  });
  invalidateCompanySettingsCache();
});
afterEach(async () => {
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

describe("tableau de bord : échéance URSSAF et période en cours", () => {
  it("tout le CA du mois en cours : échéance close à 0 €, période en cours avec encaissé et cotisations estimées", async () => {
    const now = new Date(2026, 9, 13, 12);
    await paidOn(new Date(2026, 9, 5, 10), 321660);
    const snap = await getDashboardSnapshot("month", null, now);
    expect(snap.echeance).toMatchObject({ periodKey: "2026-09", status: "clear", encaisseCents: 0, amountDueCents: 0 });
    expect(snap.echeance.enCours).toMatchObject({ periodKey: "2026-10", encaisseCents: 321660 });
    expect(snap.echeance.enCours.estimatedDueCents).toBe(snap.cashflow.urssafCents);
    expect(snap.echeance.enCours.estimatedDueCents).toBeGreaterThan(0);
    expect(new Date(snap.echeance.enCours.deadline).getMonth()).toBe(10);
  });

  it("CA du mois précédent : il porte l'échéance en cours, la période en cours reste à 0 €", async () => {
    const now = new Date(2026, 9, 13, 12);
    await paidOn(new Date(2026, 8, 20, 10), 100000);
    const snap = await getDashboardSnapshot("month", null, now);
    expect(snap.echeance).toMatchObject({ periodKey: "2026-09", status: "due", encaisseCents: 100000 });
    expect(snap.echeance.enCours).toMatchObject({ periodKey: "2026-10", encaisseCents: 0, estimatedDueCents: 0 });
  });
});
