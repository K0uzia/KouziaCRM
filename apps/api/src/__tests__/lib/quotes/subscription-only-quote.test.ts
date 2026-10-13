import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
  SubscriptionCollectionMethod,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

// SMTP « configuré » : les e-mails restent dans la file (pas de worker) ; PDF non rendu.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/send-document-pdf.js", () => ({ sendDocumentPdf: vi.fn(async () => ({ sent: false })) }));

const { issueQuote, acceptQuoteByClient, convertQuoteToInvoice, issueInvoice } = await import(
  "@/lib/invoices/transitions.js"
);
const { generateDueSubscriptionInvoices } = await import("@/lib/subscriptions/subscription-service.js");
const { notifyStripeSubscriptionSetup } = await import("@/lib/subscriptions/activate-from-document.js");
const { ensureQuoteMilestonesFromSettings } = await import("@/lib/payments/milestonePaymentService.js");
const { assertSubscriptionLinesValid } = await import("@/lib/invoices/totals.js");
const { resolveAcceptedPlan, PaymentPlanError } = await import("@/lib/quotes/payment-plans.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  await resetDb();
});

async function setStripe(enabled: boolean) {
  await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: enabled } });
  invalidateCompanySettingsCache();
}

type Line = { description: string; unitPriceCents: number; sub?: { interval?: "MONTH" | "YEAR" } };

async function quoteWith(lines: Line[]) {
  const client = await createClient({ displayName: "Lou Abonnée", type: "B2C" });
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt("lou@example.test") } });
  const service = await createService({ name: "Maintenance", unitPriceCents: 2900 });
  const total = lines.reduce((s, l) => s + l.unitPriceCents, 0);
  const quote = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: total,
      totalCents: total,
      paymentPlanOffer: "TWO",
      lines: {
        create: lines.map((l, i) => ({
          position: i + 1,
          description: l.description,
          quantity: 1,
          unitPriceCents: l.unitPriceCents,
          lineTotalCents: l.unitPriceCents,
          isSubscription: Boolean(l.sub),
          billingDay: l.sub ? 1 : null,
          billingInterval: l.sub?.interval === "YEAR" ? "YEAR" : null,
          serviceId: l.sub ? service.id : null,
        })),
      },
    },
  });
  return { client, quote };
}

const outbox = async (kind: string) =>
  (await prisma.emailOutbox.findMany()).map((r) => parsePayload(r.payload)).filter((p) => p.kind === kind);

describe("devis d'abonnement seul", () => {
  it("émis sans échéancier ni acompte (offre NONE), même en lecture ultérieure des jalons", async () => {
    const { quote } = await quoteWith([{ description: "Maintenance site : mensuel", unitPriceCents: 2900, sub: {} }]);
    const issued = await issueQuote(quote.id);
    expect(issued.paymentPlanOffer).toBe("NONE");
    expect(await prisma.paymentMilestone.count({ where: { quoteId: quote.id } })).toBe(0);
    // Les créateurs paresseux (fiche marché, espace client) ne recréent rien.
    expect(await ensureQuoteMilestonesFromSettings(quote.id, issued.totalCents)).toEqual([]);
    expect(await prisma.paymentMilestone.count({ where: { quoteId: quote.id } })).toBe(0);
  });

  it("jalons créés pendant le brouillon (offre encore 2 fois) : retirés à l'émission", async () => {
    const { quote } = await quoteWith([{ description: "Maintenance site : mensuel", unitPriceCents: 2900, sub: {} }]);
    expect((await ensureQuoteMilestonesFromSettings(quote.id, 2900)).length).toBe(2);
    await issueQuote(quote.id);
    expect(await prisma.paymentMilestone.count({ where: { quoteId: quote.id } })).toBe(0);
  });

  it("signé sans Stripe : abonnement créé et 1re facture émise tout de suite, sans acompte", async () => {
    await setStripe(false);
    const { client, quote } = await quoteWith([{ description: "Maintenance site : mensuel", unitPriceCents: 2900, sub: {} }]);
    await issueQuote(quote.id);
    const before = Date.now();
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "PORTAL" });

    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId: client.id } });
    expect(sub.collectionMethod).toBe(SubscriptionCollectionMethod.MANUAL_TRANSFER);
    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: sub.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ invoiceType: InvoiceType.SIMPLE, status: InvoiceStatus.ISSUED, totalCents: 2900 });
    // L'échéance suivante avance d'un mois à partir de la signature.
    expect(sub.nextInvoiceAt.getTime()).toBeGreaterThan(before + 27 * 24 * 3600 * 1000);
    expect(await prisma.paymentMilestone.count({ where: { quoteId: quote.id } })).toBe(0);
    expect(await outbox("deposit_checkout")).toHaveLength(0);
    // Le cron ne refacture pas ce cycle.
    expect(await generateDueSubscriptionInvoices()).toBe(0);
  });

  it("signé avec Stripe : prélèvement attendu, aucune facture ERP, un seul lien envoyé", async () => {
    await setStripe(true);
    const { client, quote } = await quoteWith([{ description: "Maintenance site : mensuel", unitPriceCents: 2900, sub: {} }]);
    await issueQuote(quote.id);
    const before = Date.now();
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "PORTAL" });

    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId: client.id } });
    expect(sub.collectionMethod).toBe(SubscriptionCollectionMethod.STRIPE);
    expect(sub.stripeSubscriptionId).toBeNull();
    // 1re échéance due maintenant : le Checkout Stripe n'aura pas de période d'essai.
    expect(sub.nextInvoiceAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(sub.nextInvoiceAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(sub.setupLinkSentAt).not.toBeNull();
    expect(await prisma.invoice.count({ where: { documentType: InvoiceDocumentType.INVOICE } })).toBe(0);
    expect(await generateDueSubscriptionInvoices()).toBe(0);
    expect(await outbox("deposit_checkout")).toHaveLength(0);
    expect(await outbox("subscription_setup")).toHaveLength(1);
    // Nouvel appel (conversion, émission) : pas de second e-mail.
    await notifyStripeSubscriptionSetup([sub.id]);
    expect(await outbox("subscription_setup")).toHaveLength(1);
  });

  it("pas de facture depuis le devis, et aucune formule de paiement acceptée", async () => {
    await setStripe(false);
    const { quote } = await quoteWith([{ description: "Maintenance : mensuel", unitPriceCents: 2900, sub: {} }]);
    await issueQuote(quote.id);
    expect(() => resolveAcceptedPlan("NONE", "TWO", { requireChoice: true })).toThrow(PaymentPlanError);
    expect(resolveAcceptedPlan("NONE", undefined, { requireChoice: true })).toBeNull();
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "PORTAL" });
    await expect(convertQuoteToInvoice(quote.id)).rejects.toThrow(/facturée par l'abonnement/);
  });

  it("plusieurs lignes de même périodicité : un seul abonnement au montant cumulé", async () => {
    await setStripe(false);
    const { client, quote } = await quoteWith([
      { description: "Maintenance site : hébergement et mises à jour", unitPriceCents: 2900, sub: {} },
      { description: "Fiche Google : suivi mensuel", unitPriceCents: 1500, sub: {} },
    ]);
    await issueQuote(quote.id);
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "PORTAL" });
    const subs = await prisma.subscription.findMany({ where: { clientId: client.id } });
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ amountCents: 4400, label: "Maintenance site + Fiche Google" });
    const linked = await prisma.invoiceLine.findMany({ where: { invoiceId: quote.id } });
    expect(linked.every((l) => l.subscriptionId === subs[0]!.id)).toBe(true);
  });

  it("périodicités différentes refusées à la saisie", () => {
    expect(() =>
      assertSubscriptionLinesValid([
        { isSubscription: true, billingDay: 1, serviceId: "s1", billingInterval: "MONTH" },
        { isSubscription: true, billingDay: 1, serviceId: "s2", billingInterval: "YEAR" },
      ]),
    ).toThrow(/même périodicité/);
  });
});

describe("corrections associées", () => {
  it("facture totale : les jalons d'acompte encore payables sont annulés et perdent leur lien", async () => {
    const { quote } = await quoteWith([{ description: "Site une page", unitPriceCents: 69000 }]);
    await issueQuote(quote.id);
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "ADMIN" });
    const first = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId: quote.id, position: 1 } });
    await prisma.paymentMilestone.update({
      where: { id: first.id },
      data: { status: MilestoneStatus.DUE, checkoutUrl: "https://exemple.test/pay" },
    });
    await convertQuoteToInvoice(quote.id);
    const after = await prisma.paymentMilestone.findMany({ where: { quoteId: quote.id } });
    expect(after.every((m) => m.status === MilestoneStatus.CANCELLED && m.checkoutUrl === null)).toBe(true);
  });

  it("facture avec ligne abonnement pour un client déjà abonné : l'échéance suivante est décalée d'une période", async () => {
    await setStripe(false);
    const { client, quote } = await quoteWith([{ description: "Maintenance : mensuel", unitPriceCents: 2900, sub: {} }]);
    await issueQuote(quote.id);
    await acceptQuoteByClient(quote.id, "Lou Abonnée", { source: "PORTAL" });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId: client.id } });
    const service = await prisma.service.findFirstOrThrow();
    const invoice = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: client.id,
        subtotalCents: 3900,
        totalCents: 3900,
        lines: {
          create: [{ position: 1, description: "Maintenance renforcée", quantity: 1, unitPriceCents: 3900, lineTotalCents: 3900, isSubscription: true, billingDay: 1, serviceId: service.id }],
        },
      },
    });
    await issueInvoice(invoice.id);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.amountCents).toBe(3900);
    const expected = new Date(sub.nextInvoiceAt);
    expected.setMonth(expected.getMonth() + 1);
    expect(after.nextInvoiceAt.getTime()).toBe(expected.getTime());
  });

  it("cron : une facture déjà émise dans le cycle (autre jour que l'échéance) n'est pas doublée", async () => {
    const client = await createClient();
    const service = await createService();
    const due = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const sub = await prisma.subscription.create({
      data: { clientId: client.id, serviceId: service.id, label: "Maintenance", amountCents: 2900, billingDay: 1, startDate: due, nextInvoiceAt: due },
    });
    await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        clientId: client.id,
        subscriptionId: sub.id,
        issueDate: new Date(due.getTime() + 2 * 24 * 3600 * 1000),
        subtotalCents: 2900,
        totalCents: 2900,
      },
    });
    expect(await generateDueSubscriptionInvoices()).toBe(0);
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id } })).toBe(1);
  });
});
