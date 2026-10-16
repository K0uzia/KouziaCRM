// Départ de la facturation d'une ligne d'abonnement de devis (signature, livraison, date, mois offerts), jour de
// prélèvement du client, et première échéance Stripe (trial_end ou billing_cycle_anchor).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/send-document-pdf.js", () => ({ sendDocumentPdf: vi.fn(async () => ({ sent: false })) }));

const { issueQuote, acceptQuoteByClient, startDeferredSubscriptions, convertQuoteToInvoice } = await import("@/lib/invoices/transitions.js");
const { computeNextInvoiceAt } = await import("@/lib/subscriptions/subscription-service.js");
const { activationPoint, lineFirstInvoiceAt, publicStart, startPhrase } = await import("@/lib/subscriptions/start.js");
const { firstChargeTiming } = await import("@/lib/stripe/checkout.js");
const { computeLineTotals } = await import("@/lib/invoices/totals.js");
const { buildInvoicePdfPayload } = await import("@/lib/pdf/build-payload.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: false } });
  invalidateCompanySettingsCache();
});
afterEach(async () => {
  await resetDb();
});

const none = { subscriptionStart: null, subscriptionStartDate: null, subscriptionFreeMonths: null };
const inMonths = (n: number, from = new Date()) => {
  const d = new Date(from);
  d.setMonth(d.getMonth() + n);
  return d;
};

type Sub = { start?: string; date?: Date; months?: number; interval?: "YEAR"; billingDay?: number | null };
/** Devis d'un client professionnel (pas de délai de rétractation) ; `project` ajoute une ligne ponctuelle (devis mixte). */
async function quote(subs: Sub[], opts: { project?: boolean; clientBillingDay?: number } = {}) {
  const client = await createClient({ displayName: "Lou Pro", type: "B2B" });
  await prisma.client.update({
    where: { id: client.id },
    data: { emailEncrypted: encrypt("lou@example.test"), ...(opts.clientBillingDay ? { billingDay: opts.clientBillingDay } : {}) },
  });
  const service = await createService({ name: "Maintenance", unitPriceCents: 2900 });
  const oneOff = opts.project ? 69000 : 0;
  const total = oneOff + subs.length * 2900;
  const q = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: total,
      totalCents: total,
      paymentPlanOffer: "TWO",
      lines: {
        create: [
          ...(opts.project ? [{ position: 1, description: "Site une page", quantity: 1, unitPriceCents: oneOff, lineTotalCents: oneOff }] : []),
          ...subs.map((s, i) => ({
            position: (opts.project ? 2 : 1) + i,
            description: `Abonnement ${i + 1}`,
            quantity: 1,
            unitPriceCents: 2900,
            lineTotalCents: 2900,
            isSubscription: true,
            billingDay: s.billingDay === undefined ? 1 : s.billingDay,
            billingInterval: s.interval ?? null,
            serviceId: service.id,
            subscriptionStart: s.start ?? null,
            subscriptionStartDate: s.date ?? null,
            subscriptionFreeMonths: s.months ?? null,
          })),
        ],
      },
    },
  });
  await issueQuote(q.id);
  return { client, quoteId: q.id };
}
const subsOf = (clientId: string) => prisma.subscription.findMany({ where: { clientId }, orderBy: { label: "asc" } });

describe("règles du départ", () => {
  it("1re facture au premier jour de prélèvement à partir de la date ou après les mois offerts ; jamais avant l'activation", () => {
    const base = new Date(2027, 0, 10);
    expect(lineFirstInvoiceAt({ ...none, subscriptionStart: "DATE", subscriptionStartDate: new Date(2027, 2, 1) }, 1, base)).toEqual(new Date(2027, 2, 1));
    expect(lineFirstInvoiceAt({ ...none, subscriptionStart: "DATE", subscriptionStartDate: new Date(2027, 2, 2) }, 1, base)).toEqual(new Date(2027, 3, 1));
    expect(lineFirstInvoiceAt({ ...none, subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 12 }, 15, base)).toEqual(new Date(2028, 0, 15));
    // Date déjà passée à l'activation : départ habituel (facturée tout de suite).
    expect(lineFirstInvoiceAt({ ...none, subscriptionStart: "DATE", subscriptionStartDate: new Date(2026, 0, 1) }, 10, base)).toBeNull();
    expect(lineFirstInvoiceAt({ ...none, subscriptionStart: "SIGNATURE" }, 1, base)).toBeNull();
  });

  it("moment d'activation et données publiques : défaut du devis, mois offerts comptés depuis ce départ", () => {
    expect(activationPoint(none, true)).toBe("DELIVERY");
    expect(activationPoint({ ...none, subscriptionStart: "DATE" }, true)).toBe("SIGNATURE");
    expect(activationPoint({ ...none, subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 3 }, true)).toBe("DELIVERY");
    expect(activationPoint({ ...none, subscriptionStart: "DELIVERY" }, false)).toBe("SIGNATURE");
    expect(publicStart(none, false)).toEqual({ startsAt: "SIGNATURE" });
    expect(publicStart({ ...none, subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 12 }, true)).toEqual({ startsAt: "DELIVERY", freeMonths: 12 });
    expect(publicStart({ ...none, subscriptionStart: "DATE", subscriptionStartDate: new Date(2027, 2, 1) }, true)).toEqual({ startsAt: "DATE", startsOn: "2027-03-01" });
  });

  it("phrase du devis et du PDF", () => {
    const clean = (s: string) => s.replace(/[  ]/g, " ");
    expect(clean(startPhrase({ ...none, subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 12 }, true, 7200, "YEAR"))).toBe(
      "12 mois offerts à partir de la livraison du projet, puis 72,00 € par an",
    );
    expect(clean(startPhrase({ ...none, subscriptionStart: "DATE", subscriptionStartDate: new Date(2027, 2, 1) }, false, 2900, "MONTH"))).toBe(
      "29,00 € par mois à partir du 1er mars 2027",
    );
    expect(clean(startPhrase({ ...none, subscriptionStart: "SIGNATURE" }, true, 2900, "MONTH"))).toBe("29,00 € par mois à partir de la signature");
  });

  it("Stripe : trial_end au-delà de 48 h, billing_cycle_anchor sans prorata en deçà, rien si l'échéance est passée", () => {
    const now = new Date(2027, 0, 1, 12).getTime();
    const in3days = new Date(now + 3 * 86_400_000);
    const in1day = new Date(now + 86_400_000);
    expect(firstChargeTiming(in3days, now)).toEqual({ trial_end: Math.floor(in3days.getTime() / 1000) });
    expect(firstChargeTiming(in1day, now)).toEqual({ billing_cycle_anchor: Math.floor(in1day.getTime() / 1000), proration_behavior: "none" });
    expect(firstChargeTiming(new Date(now - 1000), now)).toEqual({});
  });

  it("lignes réécrites : départ et avenant gardés sur une ligne d'abonnement, effacés ailleurs", () => {
    const { lines } = computeLineTotals([
      { description: "Abonnement", quantity: 1, unitPriceCents: 2900, isSubscription: true, billingDay: 1, revisesSubscriptionId: "abo-1", subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 6, subscriptionStartDate: new Date(2027, 0, 1) },
      { description: "Site", quantity: 1, unitPriceCents: 69000, subscriptionStart: "DATE", subscriptionStartDate: new Date(2027, 0, 1) },
    ]);
    expect(lines[0]).toMatchObject({ revisesSubscriptionId: "abo-1", subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 6, subscriptionStartDate: null });
    expect(lines[1]).toMatchObject({ revisesSubscriptionId: null, subscriptionStart: null, subscriptionStartDate: null, subscriptionFreeMonths: null });
  });
});

describe("activation à la signature et à la livraison", () => {
  it("abonnement seul, 12 mois offerts : abonnement créé à la signature, 1re facture dans 12 mois, rien de facturé", async () => {
    const { client, quoteId } = await quote([{ start: "FREE_MONTHS", months: 12, interval: "YEAR" }]);
    const before = new Date();
    await acceptQuoteByClient(quoteId, "Lou Pro", { source: "ADMIN" });
    const [sub] = await subsOf(client.id);
    expect(sub!.nextInvoiceAt).toEqual(computeNextInvoiceAt(1, inMonths(12, before)));
    expect(await prisma.invoice.count({ where: { subscriptionId: sub!.id } })).toBe(0);
  });

  it("abonnement seul à une date : 1re facture à cette date ; jour de prélèvement du client si la ligne n'en a pas", async () => {
    const date = inMonths(2);
    date.setHours(0, 0, 0, 0);
    date.setDate(15);
    const { client, quoteId } = await quote([{ start: "DATE", date, billingDay: null }], { clientBillingDay: 15 });
    await acceptQuoteByClient(quoteId, "Lou Pro", { source: "ADMIN" });
    const [sub] = await subsOf(client.id);
    expect([sub!.billingDay, sub!.nextInvoiceAt.getTime()]).toEqual([15, date.getTime()]);
    expect(await prisma.invoice.count({ where: { subscriptionId: sub!.id } })).toBe(0);
  });

  it("devis avec projet : ligne « à la signature » démarrée à la signature, ligne par défaut à la livraison", async () => {
    const { client, quoteId } = await quote([{ start: "SIGNATURE" }, {}], { project: true });
    await acceptQuoteByClient(quoteId, "Lou Pro", { source: "ADMIN" });
    let subs = await subsOf(client.id);
    expect(subs.map((s) => s.label)).toEqual(["Abonnement 1"]);
    // Sans Stripe : 1re période facturée tout de suite.
    expect(await prisma.invoice.count({ where: { subscriptionId: subs[0]!.id } })).toBe(1);
    expect(await startDeferredSubscriptions(quoteId)).toHaveLength(1);
    subs = await subsOf(client.id);
    expect(subs.map((s) => s.label)).toEqual(["Abonnement 1", "Abonnement 2"]);
  });

  it("devis avec projet, 3 mois offerts : rien à la signature, puis 1re facture 3 mois après la livraison", async () => {
    const { client, quoteId } = await quote([{ start: "FREE_MONTHS", months: 3 }], { project: true });
    await acceptQuoteByClient(quoteId, "Lou Pro", { source: "ADMIN" });
    expect(await subsOf(client.id)).toEqual([]);
    const delivered = new Date();
    await startDeferredSubscriptions(quoteId);
    const [sub] = await subsOf(client.id);
    expect(sub!.nextInvoiceAt).toEqual(computeNextInvoiceAt(1, inMonths(3, delivered)));
    expect(await prisma.invoice.count({ where: { subscriptionId: sub!.id } })).toBe(0);
  });

  it("12 mois offerts : Net à payer = partie ponctuelle seule (devis, acomptes, PDF, facture du devis)", async () => {
    const client = await createClient({ displayName: "Lou Pro", type: "B2B" });
    const service = await createService({ name: "Adresses e-mail", unitPriceCents: 7200 });
    // Même calcul que la route de création d'un devis.
    const computed = computeLineTotals([
      { description: "Site une page", quantity: 1, unitPriceCents: 69000 },
      { description: "Adresses e-mail", quantity: 1, unitPriceCents: 7200, isSubscription: true, billingDay: 1, billingInterval: "YEAR", serviceId: service.id, subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 12 },
      { description: "Maintenance", quantity: 1, unitPriceCents: 2900, isSubscription: true, billingDay: 1, serviceId: service.id },
    ]);
    // La maintenance (départ par défaut, facturée à la livraison) reste dans le total ; l'abonnement offert non.
    expect([computed.subtotalCents, computed.totalCents]).toEqual([71900, 71900]);
    const onlyOffered = computeLineTotals([
      { description: "Site une page", quantity: 1, unitPriceCents: 69000 },
      { description: "Adresses e-mail", quantity: 1, unitPriceCents: 7200, isSubscription: true, billingDay: 1, billingInterval: "YEAR", serviceId: service.id, subscriptionStart: "FREE_MONTHS", subscriptionFreeMonths: 12 },
    ]);
    expect(onlyOffered.totalCents).toBe(69000);
    const q = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE,
        status: InvoiceStatus.DRAFT,
        clientId: client.id,
        subtotalCents: onlyOffered.subtotalCents,
        totalCents: onlyOffered.totalCents,
        paymentPlanOffer: "TWO",
        lines: { create: onlyOffered.lines },
      },
    });
    const issued = await issueQuote(q.id);
    expect([issued.totalCents, issued.depositBaseCents]).toEqual([69000, 69000]);
    const milestones = await prisma.paymentMilestone.findMany({ where: { quoteId: q.id } });
    expect(milestones.reduce((s, m) => s + m.amountCents, 0)).toBe(69000);

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: q.id },
      include: { client: true, lines: { orderBy: { position: "asc" } }, milestones: true, payments: true },
    });
    const settings = await prisma.companySettings.findFirstOrThrow();
    const payload = buildInvoicePdfPayload({ invoice, settings, clauses: [] } as never);
    expect(payload.totalCents).toBe(69000);
    expect(payload.lines.map((l) => [l.description, l.inTotal])).toEqual([
      ["Site une page", true],
      ["Adresses e-mail", false],
    ]);

    await acceptQuoteByClient(q.id, "Lou Pro", { source: "ADMIN" });
    const { id: invoiceId } = await convertQuoteToInvoice(q.id);
    const converted = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
    expect(converted.totalCents).toBe(69000);
    expect(converted.lines.map((l) => l.description)).toEqual(["Site une page"]);
  });

  it("PDF du devis : la phrase du départ remplace le départ par défaut", async () => {
    const { quoteId } = await quote([{ start: "FREE_MONTHS", months: 12, interval: "YEAR" }, {}], { project: true });
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id: quoteId },
      include: { client: true, lines: { orderBy: { position: "asc" } }, milestones: true, payments: true },
    });
    const settings = await prisma.companySettings.findFirstOrThrow();
    const payload = buildInvoicePdfPayload({ invoice, settings, clauses: [] } as never);
    const subLines = payload.lines.filter((l) => l.isSubscription);
    expect(subLines.map((l) => (l.startText ? l.startText.replace(/[  ]/g, " ") : l.startText))).toEqual([
      "12 mois offerts à partir de la livraison du projet, puis 29,00 € par an",
      null,
    ]);
  });
});
