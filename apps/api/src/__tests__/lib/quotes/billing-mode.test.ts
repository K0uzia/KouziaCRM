import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";
import { listDeposit2Todos, milestoneAmounts, planTemplate, type PlanSettings } from "@/lib/quotes/payment-plans.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { assertBillingModeLines, periodAmountCents } from "@/lib/quotes/billing-mode.js";
import { subscriptionPriceData } from "@/lib/stripe/checkout.js";

vi.mock("@/lib/email/send-document-pdf.js", () => ({ sendDocumentPdf: vi.fn(async () => ({ sent: false })) }));

const { issueQuote, acceptQuoteByClient } = await import("@/lib/invoices/transitions.js");
const { generateDueSubscriptionInvoices } = await import("@/lib/subscriptions/subscription-service.js");
const { activateMilestoneCheckout } = await import("@/lib/payments/milestonePaymentService.js");

const settings = {
  depositPercent1Bps: 3000,
  depositPercent2Bps: 7000,
  split3Percent1Bps: 3000,
  split3Percent2Bps: 4000,
  split3Percent3Bps: 3000,
  split3MinTotalCents: 50000,
  split3Step2TriggerText: "Étape",
  installmentIntervalDays: 30,
} as PlanSettings;
const DAY = 86400000;

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  await resetDb();
});

describe("mode de facturation : règles de calcul", () => {
  it("paiement unique : parts égales au centime, reste sur la dernière, datées depuis la signature", () => {
    const t = planTemplate("THREE", settings, "ONE_OFF");
    expect(t.map((m) => [m.label, m.percentBps, m.triggerText])).toEqual([
      ["1re échéance", 3333, "À la signature"],
      ["2e échéance", 3333, "30 jours après la signature"],
      ["3e échéance", 3334, "60 jours après la signature"],
    ]);
    expect(milestoneAmounts(100000, t, "ONE_OFF").map((m) => m.amountCents)).toEqual([33333, 33333, 33334]);
    expect(milestoneAmounts(100001, planTemplate("TWO", settings, "ONE_OFF"), "ONE_OFF").map((m) => m.amountCents)).toEqual([50001, 50000]);
    expect(planTemplate("ONE", settings, "ONE_OFF")).toEqual([{ position: 1, label: "Paiement comptant", percentBps: 10000, triggerText: "À la signature" }]);
    expect(planTemplate("ONE", settings, "RECURRING")[0]!.label).toBe("Frais de mise en service");
    // Devis sans mode : pourcentages des réglages, comme avant.
    expect(milestoneAmounts(100000, planTemplate("TWO", settings), null).map((m) => m.amountCents)).toEqual([30000, 70000]);
  });

  it("récurrent : annuel / 4 ou / 12, arrondi au centime, sans majoration", () => {
    expect(periodAmountCents(150000, "YEAR")).toBe(150000);
    expect(periodAmountCents(150000, "QUARTER")).toBe(37500);
    expect(periodAmountCents(150000, "MONTH")).toBe(12500);
    expect(periodAmountCents(290000, "MONTH")).toBe(24167);
  });

  it("lignes : pas d'abonnement en paiement unique ; en récurrent, mêmes période, engagement, départ et jour", () => {
    const sub = { isSubscription: true, billingInterval: "QUARTER", commitmentMonths: 36, subscriptionStart: "SIGNATURE", billingDay: 1 };
    expect(() => assertBillingModeLines("ONE_OFF", [{ isSubscription: false }, sub])).toThrow(/Paiement unique/);
    expect(() => assertBillingModeLines("RECURRING", [{ isSubscription: false }])).toThrow(/au moins une ligne d'abonnement/);
    expect(() => assertBillingModeLines("RECURRING", [sub, { ...sub, billingInterval: "YEAR" }])).toThrow(/les mêmes/);
    expect(() => assertBillingModeLines("RECURRING", [{ isSubscription: false }, sub, { ...sub }])).not.toThrow();
    // Décision du 23/10/2026 : pas d'abonnement sans engagement en récurrent, 12 mois au minimum.
    expect(() => assertBillingModeLines("RECURRING", [{ ...sub, commitmentMonths: null }])).toThrow(/12, 24 ou 36 mois/);
    expect(() => assertBillingModeLines("RECURRING", [{ ...sub, commitmentMonths: 6 }])).toThrow(/12, 24 ou 36 mois/);
    expect(() => assertBillingModeLines(null, [{ isSubscription: false }, sub, { ...sub, billingInterval: "YEAR" }])).not.toThrow();
  });

  it("Stripe : trimestriel = tous les 3 mois", () => {
    const base = { amountCents: 37500, label: "Site", service: { stripeProductId: null, billingInterval: "YEAR" } };
    expect(subscriptionPriceData({ ...base, billingInterval: "QUARTER" }).recurring).toEqual({ interval: "month", interval_count: 3 });
    expect(subscriptionPriceData({ ...base, billingInterval: "YEAR" }).recurring).toEqual({ interval: "year" });
    expect(subscriptionPriceData({ ...base, billingInterval: "MONTH" }).recurring).toEqual({ interval: "month" });
  });
});

async function quote(billingMode: "ONE_OFF" | "RECURRING", offer: string, lines: Array<Record<string, unknown>>) {
  const client = await createClient({ displayName: "Atelier Mode", type: "B2B" });
  const total = lines.reduce((s, l) => s + (l.unitPriceCents as number) * ((l.quantity as number) ?? 1), 0);
  return prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: total,
      totalCents: total,
      paymentPlanOffer: offer,
      billingMode,
      lines: {
        create: lines.map((l, i) => ({
          position: i + 1,
          quantity: 1,
          lineTotalCents: (l.unitPriceCents as number) * ((l.quantity as number) ?? 1),
          ...l,
        })) as never,
      },
    },
  });
}

describe("mode de facturation : devis émis puis signé", () => {
  it("paiement unique en 3 fois : 3 parts égales, dues à la signature, J+30 et J+60", async () => {
    const q = await quote("ONE_OFF", "THREE", [{ description: "Site vitrine", unitPriceCents: 100000 }]);
    const issued = await issueQuote(q.id);
    expect(issued.paymentPlanOffer).toBe("THREE");
    await acceptQuoteByClient(q.id, "Atelier Mode", { source: "ADMIN" });
    const signed = await prisma.invoice.findUniqueOrThrow({ where: { id: q.id } });
    const ms = await prisma.paymentMilestone.findMany({ where: { quoteId: q.id }, orderBy: { position: "asc" } });
    expect(ms.map((m) => [m.label, m.amountCents])).toEqual([
      ["1re échéance", 33333],
      ["2e échéance", 33333],
      ["3e échéance", 33334],
    ]);
    const at = signed.quoteDecidedAt!.getTime();
    expect(ms.map((m) => Math.round((m.dueDate!.getTime() - at) / DAY))).toEqual([0, 30, 60]);
  });

  it("paiement unique en 3 fois : la 2e échéance datée reçoit son lien, sans attendre d'étape de projet", async () => {
    await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: true } });
    invalidateCompanySettingsCache();
    const q = await quote("ONE_OFF", "THREE", [{ description: "Site vitrine", unitPriceCents: 100000 }]);
    await issueQuote(q.id);
    await acceptQuoteByClient(q.id, "Atelier Mode", { source: "ADMIN" });
    const second = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId: q.id, position: 2 } });
    const activated = await activateMilestoneCheckout(second.id);
    expect(activated).toMatchObject({ status: "DUE" });
    expect(activated.checkoutUrl).toBeTruthy();
    // Dates des échéances : aucune étape de projet attendue côté tableau de bord.
    const todos = await listDeposit2Todos(prisma);
    expect([...todos.missingStep, ...todos.toInvoice].some((t) => t.quoteId === q.id)).toBe(false);
  });

  it("paiement unique : sous 500 € le 3 fois retombe sur 2 fois ; le comptant reste en une fois", async () => {
    const small = await quote("ONE_OFF", "THREE", [{ description: "Fiche", unitPriceCents: 40000 }]);
    expect((await issueQuote(small.id)).paymentPlanOffer).toBe("TWO");
    expect((await prisma.paymentMilestone.findMany({ where: { quoteId: small.id } })).map((m) => m.amountCents)).toEqual([20000, 20000]);
    const cash = await quote("ONE_OFF", "ONE", [{ description: "Fiche", unitPriceCents: 40000 }]);
    expect((await issueQuote(cash.id)).paymentPlanOffer).toBe("ONE");
    expect((await prisma.paymentMilestone.findMany({ where: { quoteId: cash.id } })).map((m) => [m.label, m.amountCents])).toEqual([["Paiement comptant", 40000]]);
  });

  it("récurrent trimestriel avec frais : frais à la signature, UN abonnement de 375 € par trimestre sur 36 mois", async () => {
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    const sub = { isSubscription: true, billingInterval: "QUARTER", billingDay: 1, commitmentMonths: 36, subscriptionStart: "SIGNATURE", serviceId: svc.id };
    const q = await quote("RECURRING", "ONE", [
      { description: "Mise en service", unitPriceCents: 50000 },
      { description: "Site tout compris : hébergement", unitPriceCents: 25000, ...sub },
      { description: "Domaine : nom de domaine", unitPriceCents: 12500, ...sub },
    ]);
    const issued = await issueQuote(q.id);
    expect(issued.paymentPlanOffer).toBe("ONE");
    expect((await prisma.paymentMilestone.findMany({ where: { quoteId: q.id } })).map((m) => [m.label, m.amountCents])).toEqual([["Frais de mise en service", 50000]]);
    await acceptQuoteByClient(q.id, "Atelier Mode", { source: "ADMIN" });
    const subs = await prisma.subscription.findMany({ where: { clientId: q.clientId } });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ amountCents: 37500, billingInterval: "QUARTER", commitmentMonths: 36, label: "Site tout compris + Domaine" });
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: q.id, isSubscription: true } });
    expect(new Set(lines.map((l) => l.subscriptionId))).toEqual(new Set([subs[0]!.id]));
  });

  it("récurrent sans frais : pas d'échéancier ; facture du worker tous les 3 mois, période datée", async () => {
    const svc = await createService({ name: "Site tout compris", unitPriceCents: 150000 });
    const q = await quote("RECURRING", "ONE", [
      { description: "Site tout compris", unitPriceCents: 37500, isSubscription: true, billingInterval: "QUARTER", billingDay: 1, commitmentMonths: 12, serviceId: svc.id },
    ]);
    expect((await issueQuote(q.id)).paymentPlanOffer).toBe("NONE");
    await acceptQuoteByClient(q.id, "Atelier Mode", { source: "ADMIN" });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId: q.clientId } });
    await prisma.subscription.update({ where: { id: sub.id }, data: { nextInvoiceAt: new Date(2027, 0, 1, 12) } });
    expect(await generateDueSubscriptionInvoices(new Date(2027, 0, 2))).toBeGreaterThanOrEqual(1);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id, issueDate: { gte: new Date(2027, 0, 1) } }, include: { lines: true } });
    expect(inv.paymentTerms).toBe("Échéance trimestrielle : paiement à réception");
    expect(inv.lines[0]!.description).toBe("Site tout compris : période du 01/01/2027 au 31/03/2027");
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.nextInvoiceAt.getMonth()).toBe(3);
  });
});
