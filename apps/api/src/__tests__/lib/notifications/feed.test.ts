import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailDirection, InvoiceDocumentType, InvoiceStatus, InvoiceType, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import { listNotifications } from "@/lib/notifications/feed.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

async function quote(clientId: string, number: string, quoteStatus: QuoteStatus) {
  return prisma.invoice.create({
    data: {
      documentType: InvoiceDocumentType.QUOTE,
      invoiceType: InvoiceType.SIMPLE,
      status: InvoiceStatus.ISSUED,
      number,
      clientId,
      subtotalCents: 120000,
      totalCents: 120000,
      quoteStatus,
      quoteDecidedAt: quoteStatus === QuoteStatus.SENT ? null : new Date(),
      issueDate: new Date(),
    },
  });
}

describe("flux de notifications", () => {
  it("remonte devis accepté, devis refusé, paiement et mail récent après la date donnée", async () => {
    const since = new Date(Date.now() - 1000);
    const client = await createClient();
    const accepted = await quote(client.id, "D-2026-0100", QuoteStatus.ACCEPTED);
    await prisma.quoteAcceptanceAudit.create({
      data: { quoteId: accepted.id, signerName: "Camille Dupont", source: "PORTAL" },
    });
    await quote(client.id, "D-2026-0101", QuoteStatus.REJECTED);
    await prisma.payment.create({ data: { amountCents: 36000, method: "BANK_TRANSFER", paidAt: new Date() } });
    const thread = await prisma.emailThread.create({
      data: { subject: "Question", participants: "[]", lastMessageAt: new Date(), clientId: client.id },
    });
    const base = {
      threadId: thread.id,
      direction: EmailDirection.INBOUND,
      fromAddress: "contact@example.test",
      toAddresses: "[]",
      subject: "Question sur le devis",
    };
    await prisma.emailMessage.create({ data: { ...base, messageId: "<recent@test>", receivedAt: new Date() } });
    // Ancien mail importé à la première synchro : pas de notification.
    await prisma.emailMessage.create({
      data: { ...base, messageId: "<ancien@test>", receivedAt: new Date("2025-01-01") },
    });

    const items = await listNotifications(since);
    const kinds = items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["mail", "payment", "quote_accepted", "quote_rejected"]);
    const acc = items.find((i) => i.kind === "quote_accepted");
    expect(acc?.title).toContain("D-2026-0100");
    expect(acc?.href).toBe(`/quotes/${accepted.id}`);
  });

  it("ne renvoie rien de plus ancien que la date donnée", async () => {
    const client = await createClient();
    await quote(client.id, "D-2026-0102", QuoteStatus.REJECTED);
    const items = await listNotifications(new Date(Date.now() + 60_000));
    expect(items).toEqual([]);
  });
});
