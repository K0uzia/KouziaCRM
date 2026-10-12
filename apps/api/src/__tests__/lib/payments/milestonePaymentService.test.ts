import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
  QuoteStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings, createClient } from "../../helpers/factories.js";
import {
  onQuoteAcceptedByClient,
  prepareFirstDepositCheckoutOnQuoteSent,
} from "@/lib/payments/milestonePaymentService.js";
import { markPaidFromOnlinePayment } from "@/lib/stripe/mark-paid.js";
import { encrypt } from "@/lib/crypto.js";
import { PaymentMethod } from "@prisma/client";

vi.mock("@/lib/email/smtp.js", () => ({
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: vi.fn(async () => false),
}));

beforeEach(async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-32chars!!";
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: {
      stripeSecretKeyEncrypted: encrypt("sk_test_fake"),
      stripeWebhookSecretEncrypted: encrypt("whsec_test"),
      moduleStripeEnabled: true,
      depositCount: 2,
      depositPercent1Bps: 3000,
      depositPercent2Bps: 7000,
      depositPercent3Bps: 0,
      paymentButtonLeadDays: 7,
    },
  });
});

afterEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

describe("milestone payment service", () => {
  it("crée les jalons à l'émission du devis sans checkout", async () => {
    const client = await createClient();
    const quote = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        number: "D-2026-0001",
        clientId: client.id,
        subtotalCents: 100000,
        totalCents: 100000,
        quoteStatus: QuoteStatus.SENT,
        issueDate: new Date(),
      },
    });

    await prepareFirstDepositCheckoutOnQuoteSent(quote.id);

    const milestone = await prisma.paymentMilestone.findFirst({
      where: { quoteId: quote.id, position: 1 },
    });

    expect(milestone?.amountCents).toBe(30000);
    expect(milestone?.status).toBe(MilestoneStatus.PENDING);
    expect(milestone?.checkoutUrl).toBeNull();

    const all = await prisma.paymentMilestone.findMany({
      where: { quoteId: quote.id },
      orderBy: { position: "asc" },
    });
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.label)).toEqual(["Acompte", "Solde"]);
    expect(all[1]?.amountCents).toBe(70000);
  });

  it("crée le lien ERP Stripe après acceptation du devis", async () => {
    const client = await createClient();
    const quote = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        number: "D-2026-0004",
        clientId: client.id,
        subtotalCents: 100000,
        totalCents: 100000,
        quoteStatus: QuoteStatus.ACCEPTED,
        issueDate: new Date(),
      },
    });

    await onQuoteAcceptedByClient(quote.id);

    const milestone = await prisma.paymentMilestone.findFirst({
      where: { quoteId: quote.id, position: 1 },
    });

    expect(milestone?.amountCents).toBe(30000);
    expect(milestone?.status).toBe(MilestoneStatus.DUE);
    expect(milestone?.checkoutUrl).toContain("/api/public/pay/");
  });

  it("accepte le devis sans Stripe : acompte à payer, sans checkout", async () => {
    await prisma.companySettings.updateMany({ data: { moduleStripeEnabled: false } });
    const client = await createClient();
    const quote = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        number: "D-2026-0005",
        clientId: client.id,
        subtotalCents: 100000,
        totalCents: 100000,
        quoteStatus: QuoteStatus.ACCEPTED,
        issueDate: new Date(),
      },
    });

    await onQuoteAcceptedByClient(quote.id);

    const milestone = await prisma.paymentMilestone.findFirst({
      where: { quoteId: quote.id, position: 1 },
    });
    expect(milestone?.status).toBe(MilestoneStatus.DUE);
    expect(milestone?.checkoutUrl).toBeNull();
  });

  it("ne recrée pas de checkout à l'acceptation si l'acompte est déjà payé", async () => {
    const client = await createClient();
    const quote = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        number: "D-2026-0003",
        clientId: client.id,
        subtotalCents: 100000,
        totalCents: 100000,
        quoteStatus: QuoteStatus.ACCEPTED,
        issueDate: new Date(),
      },
    });

    await prisma.paymentMilestone.create({
      data: {
        quoteId: quote.id,
        position: 1,
        label: "Acompte",
        percentBps: 3000,
        amountCents: 30000,
        triggerText: "Signature",
        status: MilestoneStatus.PAID,
        paidAt: new Date(),
      },
    });

    await onQuoteAcceptedByClient(quote.id);

    const milestones = await prisma.paymentMilestone.findMany({ where: { quoteId: quote.id } });
    expect(milestones.filter((m) => m.position === 1)).toHaveLength(1);
    expect(milestones[0]?.checkoutUrl).toBeNull();
  });

  it("enregistre un paiement Stripe une seule fois (idempotence PI)", async () => {
    const client = await createClient();
    const quote = await prisma.invoice.create({
      data: {
        documentType: InvoiceDocumentType.QUOTE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.ISSUED,
        number: "D-2026-0002",
        clientId: client.id,
        subtotalCents: 50000,
        totalCents: 50000,
        quoteStatus: QuoteStatus.ACCEPTED,
        issueDate: new Date(),
        lines: {
          create: [
            {
              position: 1,
              description: "Prestation test",
              quantity: 1,
              unitPriceCents: 50000,
              lineTotalCents: 50000,
            },
          ],
        },
      },
    });

    const milestone = await prisma.paymentMilestone.create({
      data: {
        quoteId: quote.id,
        position: 1,
        label: "Acompte",
        percentBps: 3000,
        amountCents: 15000,
        triggerText: "Signature",
        status: MilestoneStatus.DUE,
      },
    });

    const first = await markPaidFromOnlinePayment({
      amountCents: 15000,
      method: PaymentMethod.CARD,
      paymentIntentId: "pi_idem_1",
      feeCents: 45,
      milestoneId: milestone.id,
      notes: "Paiement Stripe",
    });
    expect(first.duplicate).toBe(false);
    expect(await prisma.payment.count()).toBe(1);

    const second = await markPaidFromOnlinePayment({
      amountCents: 15000,
      method: PaymentMethod.CARD,
      paymentIntentId: "pi_idem_1",
      feeCents: 45,
      milestoneId: milestone.id,
    });
    expect(second.duplicate).toBe(true);
    expect(await prisma.payment.count()).toBe(1);

    const pay = await prisma.payment.findFirst();
    expect(pay?.feeCents).toBe(45);
  });
});
