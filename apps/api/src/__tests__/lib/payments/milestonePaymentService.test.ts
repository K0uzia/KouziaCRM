import { createHmac } from "node:crypto";
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
import {
  seedCompanySettings,
  createClient,
} from "../../helpers/factories.js";
import {
  markMilestonePaidFromRevolut,
  onQuoteAcceptedByClient,
  prepareFirstDepositCheckoutOnQuoteSent,
} from "@/lib/payments/milestonePaymentService.js";
import {
  verifyRevolutWebhookSignature,
} from "@/lib/revolut/merchantService.js";
import * as merchantService from "@/lib/revolut/merchantService.js";

vi.mock("@/lib/revolut/merchantService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof merchantService>();
  return {
    ...actual,
    createRevolutOrder: vi.fn(
      async (input: { amountCents: number; reference: string }) => ({
        id: `ord_${input.reference}`,
        token: "tok_test",
        checkoutUrl: `https://sandbox.revolut.com/checkout/${input.reference}`,
        state: "pending",
      }),
    ),
    getRevolutMerchantConfig: vi.fn(async () => ({
      apiKey: "sk_test",
      webhookSecret: "whsec_test",
      mode: "sandbox" as const,
      baseUrl: "https://sandbox-merchant.revolut.com",
    })),
  };
});

vi.mock("@/lib/email/smtp.js", () => ({
  sendEmail: vi.fn(async () => undefined),
  isSmtpConfigured: vi.fn(async () => false),
}));

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
    await prisma.companySettings.updateMany({
    data: {
      revolutMerchantApiKeyEncrypted: "enc:test",
      revolutWebhookSecretEncrypted: "enc:whsec",
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
  it("crée les jalons à l'émission du devis sans checkout Revolut", async () => {
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
    expect(milestone?.revolutOrderId).toBeNull();
    expect(merchantService.createRevolutOrder).not.toHaveBeenCalled();

    const all = await prisma.paymentMilestone.findMany({
      where: { quoteId: quote.id },
      orderBy: { position: "asc" },
    });
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.label)).toEqual(["Acompte", "Solde"]);
    expect(all[1]?.amountCents).toBe(70000);
  });

  it("crée le checkout Revolut après acceptation du devis", async () => {
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
    expect(milestone?.checkoutUrl).toContain("checkout");
    expect(merchantService.createRevolutOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 30000, reference: milestone?.id }),
    );
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

    expect(merchantService.createRevolutOrder).not.toHaveBeenCalled();
  });

  it("ignore un webhook Revolut dupliqué (idempotence)", async () => {
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
        revolutOrderId: "ord_dup",
      },
    });

    const eventId = `evt_dup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const payload = { event: "ORDER_COMPLETED", order: { id: "ord_dup" } };
    const first = await markMilestonePaidFromRevolut({
      milestoneId: milestone.id,
      revolutOrderId: "ord_dup",
      revolutPaymentId: "pay_1",
      eventId,
      eventType: "ORDER_COMPLETED",
      payload,
    });

    expect(first.duplicate).toBe(false);
    expect(await prisma.payment.count()).toBe(1);

    const second = await markMilestonePaidFromRevolut({
      milestoneId: milestone.id,
      revolutOrderId: "ord_dup",
      revolutPaymentId: "pay_1",
      eventId,
      eventType: "ORDER_COMPLETED",
      payload,
    });

    expect(second.duplicate).toBe(true);
    expect(await prisma.payment.count()).toBe(1);
  });
});

describe("verifyRevolutWebhookSignature intégration", () => {
  it("rejette un timestamp trop ancien", () => {
    const secret = "whsec_test";
    const rawBody = "{}";
    const timestamp = String(Date.now() - 10 * 60 * 1000);
    const payloadToSign = `v1.${timestamp}.${rawBody}`;
    const signature =
      "v1=" +
      createHmac("sha256", secret).update(payloadToSign).digest("hex");

    expect(
      verifyRevolutWebhookSignature({
        rawBody,
        timestamp,
        signatureHeader: signature,
        signingSecret: secret,
        maxSkewMs: 60_000,
      }),
    ).toBe(false);
  });
});
