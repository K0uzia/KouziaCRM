/**
 * Cycle de vie d'un abonnement facturé par l'ERP (sans Stripe), avec voyage dans le temps (Date simulée) : signature,
 * échéances mensuelles, demande de non-reconduction, fin au terme, total facturé sur l'engagement (audit du 28/10/2026).
 * Décision d'Alexandre : la facturation garde la date anniversaire de la signature ; le devis le dit (pas « le 1 »).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin: vi.fn(async () => undefined) }));
const { acceptQuoteByClient, issueQuote } = await import("@/lib/invoices/transitions.js");
const { generateDueSubscriptionInvoices, scheduleSubscriptionEnd, closeEndedSubscriptions } = await import("@/lib/subscriptions/subscription-service.js");
const { buildInvoicePdfPayload } = await import("@/lib/pdf/build-payload.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  invalidateCompanySettingsCache();
});
afterEach(() => vi.useRealTimers());

async function signedMonthly(billingDay: number) {
  const client = await createClient({ displayName: "Atelier Cycle" });
  const service = await createService({ name: "Site tout compris", unitPriceCents: 10_000 });
  const quote = await prisma.invoice.create({
    data: {
      clientId: client.id, documentType: InvoiceDocumentType.QUOTE, status: InvoiceStatus.DRAFT, subtotalCents: 10_000, totalCents: 10_000,
      lines: { create: [{ position: 1, description: "Site tout compris", quantity: 1, unitPriceCents: 10_000, lineTotalCents: 10_000, isSubscription: true, billingDay, billingInterval: "MONTH", serviceId: service.id, commitmentMonths: 12 }] },
    },
  });
  await issueQuote(quote.id);
  const payload = async () =>
    buildInvoicePdfPayload({ invoice: (await prisma.invoice.findUniqueOrThrow({ where: { id: quote.id }, include: { lines: true, milestones: true, payments: true, options: true } })) as never, clientType: "B2B" });
  const before = (await payload()).lines[0]!;
  await acceptQuoteByClient(quote.id, "Cliente Cycle", { source: "ADMIN" });
  const after = (await payload()).lines[0]!;
  return { sub: await prisma.subscription.findFirstOrThrow(), before, after };
}

describe("cycle mensuel engagé 12 mois, signé le 15 janvier 2026, jour de la ligne le 1er", () => {
  it("devis : jour de facturation annoncé = celui de la signature ; 12 échéances le 15, puis fin au terme", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0));
    const { sub, before, after } = await signedMonthly(1);
    // Avant la signature : « le même jour du mois que la signature », jamais « le 1 ».
    expect(before.billingDay).toBeNull();
    expect(before.billingAnchor).toBe("SIGNATURE");
    // Signé le 15 : « le 15 ».
    expect(after.billingDay).toBe(15);
    // Avance jour par jour sur 13 mois ; demande de non-reconduction le 1er décembre 2026.
    for (let d = new Date(2026, 0, 15, 12); d < new Date(2027, 1, 20); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12)) {
      vi.setSystemTime(d);
      if (d.getFullYear() === 2026 && d.getMonth() === 11 && d.getDate() === 1) await scheduleSubscriptionEnd(sub.id, d);
      await generateDueSubscriptionInvoices(d);
      await closeEndedSubscriptions(d);
    }
    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: sub.id, documentType: "INVOICE" }, orderBy: { issueDate: "asc" } });
    const total = invoices.reduce((s, i) => s + i.totalCents, 0);
    const days = invoices.map((i) => i.issueDate!.getDate());
    const ended = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(total).toBe(12 * 10_000);
    expect(ended.status).toBe("ENDED");
    expect(days.every((day) => day === 15)).toBe(true);
  }, 300_000);
});
