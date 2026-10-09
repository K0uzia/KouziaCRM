import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MilestoneStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import { issueInvoice, issueQuote } from "@/lib/invoices/transitions.js";
import { generateMilestoneInvoice } from "@/lib/invoices/documentFlowService.js";
import {
  assertQuoteLinkable,
  generateInvoicePaymentLink,
  setInvoicePaymentLink,
} from "@/lib/invoices/payment-link.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

async function draftDoc(clientId: string, documentType: "QUOTE" | "INVOICE", extra: Record<string, unknown> = {}) {
  return prisma.invoice.create({
    data: {
      documentType,
      invoiceType: "SIMPLE",
      status: "DRAFT",
      clientId,
      subtotalCents: 119000,
      totalCents: 119000,
      quoteStatus: documentType === "QUOTE" ? QuoteStatus.DRAFT : null,
      lines: {
        create: [{ position: 0, description: "Site vitrine", quantity: 1, unitPriceCents: 119000, lineTotalCents: 119000 }],
      },
      ...extra,
    },
  });
}

async function signedQuote(clientId: string) {
  const q = await draftDoc(clientId, "QUOTE");
  await issueQuote(q.id);
  await prisma.invoice.update({
    where: { id: q.id },
    data: { quoteStatus: QuoteStatus.ACCEPTED, quoteDecidedAt: new Date() },
  });
  return q.id;
}

describe("lien de paiement d'une facture", () => {
  it("s'enregistre sur une facture émise et sur son échéance, se retire", async () => {
    const client = await createClient();
    const quoteId = await signedQuote(client.id);
    const deposit = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId, position: 1 } });
    const inv = await generateMilestoneInvoice(deposit.id);

    await expect(setInvoicePaymentLink(inv.id, "http://pas-securise.test")).rejects.toThrow(/https/);
    const url = await setInvoicePaymentLink(inv.id, "https://checkout.revolut.com/pay/abc");
    expect(url).toBe("https://checkout.revolut.com/pay/abc");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).checkoutUrl).toBe(url);
    const m = await prisma.paymentMilestone.findUniqueOrThrow({ where: { id: deposit.id } });
    expect(m.checkoutUrl).toBe(url);
    expect(m.status).not.toBe(MilestoneStatus.PENDING);

    await setInvoicePaymentLink(inv.id, null);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).checkoutUrl).toBeNull();
  });

  it("refuse un brouillon, et la génération sans module Revolut Merchant", async () => {
    const client = await createClient();
    const draft = await draftDoc(client.id, "INVOICE");
    await expect(setInvoicePaymentLink(draft.id, "https://pay.test/x")).rejects.toThrow(/Émettez/);
    await issueInvoice(draft.id);
    await prisma.companySettings.updateMany({ data: { moduleMerchantApiEnabled: false } });
    invalidateCompanySettingsCache();
    await expect(generateInvoicePaymentLink(draft.id)).rejects.toThrow(/Revolut Merchant/);
  });
});

describe("facture rattachée à un devis", () => {
  it("exige un devis signé du même client, non facturé par ailleurs", async () => {
    const client = await createClient();
    const other = await createClient({ displayName: "Autre client" });
    const quoteId = await signedQuote(client.id);

    await expect(assertQuoteLinkable(quoteId, other.id)).rejects.toThrow(/autre client/);
    await expect(assertQuoteLinkable(quoteId, client.id)).resolves.toBeTruthy();

    const unsigned = await draftDoc(client.id, "QUOTE");
    await expect(assertQuoteLinkable(unsigned.id, client.id)).rejects.toThrow(/signé/);

    // Facture totale rattachée : plus d'acompte possible, ni d'autre facture.
    const inv = await draftDoc(client.id, "INVOICE", { quoteId, sourceQuoteId: quoteId });
    await expect(assertQuoteLinkable(quoteId, client.id, inv.id)).resolves.toBeTruthy();
    await expect(assertQuoteLinkable(quoteId, client.id)).rejects.toThrow(/déjà facturé/);
    const deposit = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId, position: 1 } });
    await expect(generateMilestoneInvoice(deposit.id)).rejects.toThrow(/facturé en totalité/);
  });
});
