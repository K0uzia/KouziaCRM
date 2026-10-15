import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { InvoiceDocumentType, InvoiceStatus, SubscriptionCollectionMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, createService, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
vi.mock("@/lib/email/send-document-pdf.js", () => ({ sendDocumentPdf: vi.fn(async () => ({ sent: false })) }));

const { issueQuote, acceptQuoteByClient, convertQuoteToInvoice, startDeferredSubscriptions } = await import(
  "@/lib/invoices/transitions.js"
);
const { computeDepositBaseCents } = await import("@/lib/invoices/totals.js");
const { computeBalanceSummary } = await import("@/lib/invoices/documentFlowService.js");
const { createClientProject, projectInputSchema, updateClientProject } = await import("@/lib/projects/service.js");

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

/** Devis mixte : « Site une page » 690 € + maintenance 29 €/mois (remise facultative en centimes). */
async function mixedQuote(
  opts: { offer?: "TWO" | "CHOICE"; oneOffCents?: number; discountCents?: number; legacy?: boolean; type?: "B2B" | "B2C" } = {},
) {
  const client = await createClient({ displayName: "Lou Mixte", type: opts.type ?? "B2C" });
  await prisma.client.update({ where: { id: client.id }, data: { emailEncrypted: encrypt("lou@example.test") } });
  const service = await createService({ name: "Maintenance", unitPriceCents: 2900 });
  const oneOff = opts.oneOffCents ?? 69000;
  const subtotal = oneOff + 2900;
  const discount = opts.discountCents ?? 0;
  const quote = await prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      status: InvoiceStatus.DRAFT,
      clientId: client.id,
      subtotalCents: subtotal,
      totalCents: subtotal - discount,
      ...(discount ? { discountType: "FIXED", discountValue: discount } : {}),
      paymentPlanOffer: opts.offer ?? "TWO",
      lines: {
        create: [
          { position: 1, description: "Site une page", quantity: 1, unitPriceCents: oneOff, lineTotalCents: oneOff },
          { position: 2, description: "Maintenance : mensuel", quantity: 1, unitPriceCents: 2900, lineTotalCents: 2900, isSubscription: true, billingDay: 1, serviceId: service.id },
        ],
      },
    },
  });
  return { client, quote };
}

const outbox = async (kind: string) =>
  (await prisma.emailOutbox.findMany()).map((r) => parsePayload(outboxPayloadRaw(r))).filter((p) => p.kind === kind);

describe("base de l'acompte (partie ponctuelle)", () => {
  it("lignes hors abonnement, remise répartie au prorata", () => {
    const lines = [
      { isSubscription: false, lineTotalCents: 69000 },
      { isSubscription: true, lineTotalCents: 2900 },
    ];
    expect(computeDepositBaseCents(lines, 71900, 71900)).toBe(69000);
    // Remise de 10 % sur 719 € : 71,90 € dont 69,00 € portés par la partie ponctuelle.
    expect(computeDepositBaseCents(lines, 71900, 64710)).toBe(62100);
    expect(computeDepositBaseCents([{ isSubscription: true, lineTotalCents: 2900 }], 2900, 2900)).toBe(0);
  });
});

describe("devis mixte", () => {
  it("émis : échéancier et seuil du 3 fois sur la partie ponctuelle, pas sur le total", async () => {
    const { quote } = await mixedQuote();
    const issued = await issueQuote(quote.id);
    expect(issued.depositBaseCents).toBe(69000);
    const ms = await prisma.paymentMilestone.findMany({ where: { quoteId: quote.id }, orderBy: { position: "asc" } });
    expect(ms.map((m) => m.amountCents)).toEqual([20700, 48300]);

    // 3 fois au choix : 490 € ponctuels + 29 €/mois, total 519 € mais base sous le seuil de 500 € : 2 fois.
    const small = await mixedQuote({ offer: "CHOICE", oneOffCents: 49000 });
    expect((await issueQuote(small.quote.id)).paymentPlanOffer).toBe("TWO");
  });

  it("jalons créés pendant le brouillon sur le total : recalculés sur la base à l'émission", async () => {
    const { ensureQuoteMilestonesFromSettings } = await import("@/lib/payments/milestonePaymentService.js");
    const { quote } = await mixedQuote();
    const draft = await ensureQuoteMilestonesFromSettings(quote.id, 71900);
    expect(draft.map((m) => m.amountCents)).toEqual([21570, 50330]);
    await issueQuote(quote.id);
    const ms = await prisma.paymentMilestone.findMany({ where: { quoteId: quote.id }, orderBy: { position: "asc" } });
    expect(ms.map((m) => m.amountCents)).toEqual([20700, 48300]);
  });

  it("signé : aucun abonnement à la signature ; facture totale sur la partie ponctuelle seulement", async () => {
    await setStripe(false);
    const { client, quote } = await mixedQuote({ discountCents: 7190 });
    await issueQuote(quote.id);
    await acceptQuoteByClient(quote.id, "Lou Mixte", { source: "ADMIN" });
    expect(await prisma.subscription.count({ where: { clientId: client.id } })).toBe(0);
    expect(await outbox("subscription_setup")).toHaveLength(0);

    const balance = await computeBalanceSummary(quote.id);
    expect(balance).toMatchObject({ marketTotalCents: 62100, balanceDueCents: 62100 });

    const invoice = await convertQuoteToInvoice(quote.id);
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
    expect(lines.map((l) => l.description)).toEqual(["Site une page"]);
    expect(invoice).toMatchObject({ subtotalCents: 69000, totalCents: 62100, discountType: "FIXED", discountValue: 6900 });
    expect(await prisma.subscription.count({ where: { clientId: client.id } })).toBe(0);
  });

  it("livraison (projet terminé) sans Stripe : abonnement créé et 1re facture tout de suite, une seule fois", async () => {
    await setStripe(false);
    // Professionnel : pas de délai de rétractation (le cas du particulier est testé à part).
    const { client, quote } = await mixedQuote({ type: "B2B" });
    await issueQuote(quote.id);
    await acceptQuoteByClient(quote.id, "Lou Mixte", { source: "ADMIN" });
    const input = projectInputSchema.parse({ name: "Site une page", progress: 80, status: "ACTIVE" });
    const project = await createClientProject(client.id, input);
    await prisma.clientProject.update({ where: { id: project.id }, data: { quoteId: quote.id } });

    await updateClientProject(project.id, { ...input, status: "DONE" });
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId: client.id } });
    expect(sub).toMatchObject({ amountCents: 2900, collectionMethod: SubscriptionCollectionMethod.MANUAL_TRANSFER });
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id } })).toBe(1);

    // Réouverture puis nouvelle livraison, ou démarrage manuel : rien de plus.
    await updateClientProject(project.id, { ...input, status: "ACTIVE" });
    await updateClientProject(project.id, { ...input, status: "DONE" });
    expect(await startDeferredSubscriptions(quote.id)).toEqual([]);
    expect(await prisma.subscription.count({ where: { clientId: client.id } })).toBe(1);
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id } })).toBe(1);
  });

  it("particulier livré pendant le délai de rétractation : abonnement créé, 1re échéance après le délai", async () => {
    await setStripe(false);
    const { client, quote } = await mixedQuote();
    await issueQuote(quote.id);
    await acceptQuoteByClient(quote.id, "Lou Mixte", { source: "ADMIN" });
    expect(await startDeferredSubscriptions(quote.id)).toHaveLength(1);
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId: client.id } });
    const proof = await prisma.quoteAcceptanceAudit.findFirstOrThrow({ where: { quoteId: quote.id } });
    expect(sub.nextInvoiceAt.getTime()).toBe(proof.withdrawalEndsAt!.getTime() + 1);
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id } })).toBe(0);
  });

  it("démarrage manuel avec Stripe : prélèvement attendu, un seul lien, aucune facture ERP", async () => {
    await setStripe(true);
    const { client, quote } = await mixedQuote({ type: "B2B" });
    await issueQuote(quote.id);
    await acceptQuoteByClient(quote.id, "Lou Mixte", { source: "ADMIN" });
    expect(await startDeferredSubscriptions(quote.id)).toHaveLength(1);
    const sub = await prisma.subscription.findFirstOrThrow({ where: { clientId: client.id } });
    expect(sub.collectionMethod).toBe(SubscriptionCollectionMethod.STRIPE);
    expect(sub.nextInvoiceAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await outbox("subscription_setup")).toHaveLength(1);
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id } })).toBe(0);
  });

  it("devis émis avant la fonction (base absente) : comportement inchangé, abonnement à la signature", async () => {
    await setStripe(false);
    const { client, quote } = await mixedQuote();
    await issueQuote(quote.id);
    await prisma.invoice.update({ where: { id: quote.id }, data: { depositBaseCents: null } });
    await acceptQuoteByClient(quote.id, "Lou Mixte", { source: "ADMIN" });
    expect(await prisma.subscription.count({ where: { clientId: client.id } })).toBe(1);
    expect((await computeBalanceSummary(quote.id)).marketTotalCents).toBe(71900);
  });
});
