/**
 * Audit abonnements du 28/10/2026, points P2 : échéance par virement impayée (alerte sans suspension), reprise après
 * suspension sur la date anniversaire, clôture immédiate pendant l'engagement (échéances restantes facturées au choix).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceDocumentType, InvoiceStatus, InvoiceType, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/send-document-pdf.js", () => ({ sendDocumentPdf: vi.fn(async () => ({ sent: false })) }));
const alertAdmin = vi.fn(async (..._a: unknown[]) => true);
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin }));

const { alertOverdueTransferSubscriptions, TRANSFER_OVERDUE_ALERT_DAYS } = await import("@/lib/subscriptions/dunning.js");
const { endSubscription, listSubscriptions, pauseSubscription, resumeSubscription } = await import("@/lib/subscriptions/subscription-service.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  invalidateCompanySettingsCache();
  alertAdmin.mockClear();
});

async function sub(extra: Record<string, unknown> = {}) {
  const c = await createClient({ displayName: "Atelier P2" });
  const s = await createService();
  return prisma.subscription.create({
    data: { clientId: c.id, serviceId: s.id, label: "Site tout compris", amountCents: 10_000, billingDay: 1, billingInterval: "MONTH", startDate: new Date(2026, 0, 15), nextInvoiceAt: new Date(2026, 10, 15), ...extra },
  });
}

describe("abonnement par virement : échéance impayée", () => {
  it(`alerte une fois par facture après ${TRANSFER_OVERDUE_ALERT_DAYS} jours, sans suspendre`, async () => {
    const s = await sub();
    const inv = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE, invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, number: "F-2026-0801", clientId: s.clientId, subscriptionId: s.id,
        issueDate: new Date(2026, 9, 1), dueDate: new Date(2026, 9, 1), subtotalCents: 10_000, totalCents: 10_000,
      },
    });
    expect(await alertOverdueTransferSubscriptions(new Date(2026, 9, 10))).toBe(0);
    expect(await alertOverdueTransferSubscriptions(new Date(2026, 9, 20))).toBe(1);
    expect(alertAdmin.mock.calls[0]![2]).toEqual({ kind: "subscription_overdue_alert", documentId: inv.id });
    // Une alerte par facture : la file d'envoi la garde (simulée ici).
    await prisma.emailOutbox.create({ data: { payload: "", reviewKind: "subscription_overdue_alert", documentId: inv.id, status: "SENT" } });
    expect(await alertOverdueTransferSubscriptions(new Date(2026, 9, 21))).toBe(0);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(SubscriptionStatus.ACTIVE);
  });

  it("prélèvement Stripe : pas concerné (Stripe relance et suspend lui-même)", async () => {
    const s = await sub({ collectionMethod: "STRIPE" });
    await prisma.invoice.create({
      data: { documentType: InvoiceDocumentType.INVOICE, status: InvoiceStatus.ISSUED, number: "F-2026-0802", clientId: s.clientId, subscriptionId: s.id, issueDate: new Date(2026, 9, 1), dueDate: new Date(2026, 9, 1), subtotalCents: 10_000, totalCents: 10_000 },
    });
    expect(await alertOverdueTransferSubscriptions(new Date(2026, 9, 20))).toBe(0);
  });
});

describe("reprise après suspension", () => {
  it("annuel : la prochaine échéance garde la date anniversaire (le 15), sans facturer la période suspendue", async () => {
    const s = await sub({ billingInterval: "YEAR", nextInvoiceAt: new Date(2026, 2, 15) });
    await pauseSubscription(s.id);
    const resumed = await resumeSubscription(s.id, new Date(2026, 5, 2));
    expect(resumed.nextInvoiceAt).toEqual(new Date(2027, 2, 15));
  });

  it("trimestriel : prochain trimestre sur l'ancrage", async () => {
    const s = await sub({ billingInterval: "QUARTER", nextInvoiceAt: new Date(2026, 2, 15) });
    await pauseSubscription(s.id);
    expect((await resumeSubscription(s.id, new Date(2026, 5, 2))).nextInvoiceAt).toEqual(new Date(2026, 5, 15));
  });
});

describe("clôture immédiate pendant l'engagement", () => {
  it("la liste annonce les échéances restantes ; clôturer en les facturant émet une facture au tarif plein", async () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 15);
    const s = await sub({ nextInvoiceAt: next, commitmentMonths: 12, commitmentEndsAt: new Date(next.getFullYear(), next.getMonth() + 4, 15) });
    const row = (await listSubscriptions()).find((r) => r.id === s.id)!;
    expect(row.remainingCommitment).toMatchObject({ count: 4, amountCents: 40_000 });
    await endSubscription(s.id, undefined, { invoiceRemaining: true });
    const inv = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: s.id, documentType: InvoiceDocumentType.INVOICE }, include: { lines: true } });
    expect(inv).toMatchObject({ status: InvoiceStatus.ISSUED, totalCents: 40_000 });
    expect(inv.number).toBeTruthy();
    expect(inv.lines[0]!.description).toContain("échéances restantes de l'engagement");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.id } })).status).toBe(SubscriptionStatus.ENDED);
  });

  it("sans la case : clôture sans facture ; abonnement hors engagement : rien à facturer", async () => {
    const s = await sub({ commitmentMonths: 12, commitmentEndsAt: new Date(2020, 0, 1) });
    expect((await listSubscriptions()).find((r) => r.id === s.id)!.remainingCommitment).toBeNull();
    await expect(endSubscription(s.id, undefined, { invoiceRemaining: true })).rejects.toThrow(/Aucune échéance/);
    await endSubscription(s.id);
    expect(await prisma.invoice.count({ where: { subscriptionId: s.id } })).toBe(0);
  });
});
