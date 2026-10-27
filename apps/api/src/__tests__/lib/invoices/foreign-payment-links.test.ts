import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MilestoneStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import { issueQuote } from "@/lib/invoices/transitions.js";
import { generateMilestoneInvoice } from "@/lib/invoices/documentFlowService.js";
import { reportForeignPaymentLinks } from "@/lib/invoices/foreign-payment-links.js";
import { listNotifications } from "@/lib/notifications/feed.js";

// Liens de paiement hors Stripe enregistrés avant la règle (27/10/2026) : le worker les signale une fois à Alexandre
// (e-mail d'alerte, cloche, push) sans rien modifier.

const ORIGIN = process.env.PUBLIC_API_ORIGIN;
beforeEach(async () => {
  process.env.PUBLIC_API_ORIGIN = "https://api.kouzia.test";
  await resetDb();
  await seedCompanySettings();
});
afterEach(async () => {
  if (ORIGIN === undefined) delete process.env.PUBLIC_API_ORIGIN;
  else process.env.PUBLIC_API_ORIGIN = ORIGIN;
  await resetDb();
});

async function signedQuote() {
  const client = await createClient();
  const q = await prisma.invoice.create({
    data: {
      documentType: "QUOTE",
      invoiceType: "SIMPLE",
      status: "DRAFT",
      clientId: client.id,
      subtotalCents: 100_000,
      totalCents: 100_000,
      quoteStatus: QuoteStatus.DRAFT,
      lines: { create: [{ position: 0, description: "Site vitrine", quantity: 1, unitPriceCents: 100_000, lineTotalCents: 100_000 }] },
    },
  });
  await issueQuote(q.id);
  await prisma.invoice.update({ where: { id: q.id }, data: { quoteStatus: QuoteStatus.ACCEPTED, quoteDecidedAt: new Date() } });
  return q.id;
}

describe("contrôle des liens déjà enregistrés (worker, lecture seule)", () => {
  it("signale une fois chaque facture ou échéance au lien hors liste, sans la modifier", async () => {
    const since = new Date(Date.now() - 1000);
    await prisma.companySettings.updateMany({ data: { email: "alexandre@kouzia.test" } });
    invalidateCompanySettingsCache();
    const quoteId = await signedQuote();
    const deposit = await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId, position: 1 } });
    const inv = await generateMilestoneInvoice(deposit.id);
    await prisma.invoice.update({ where: { id: inv.id }, data: { checkoutUrl: "https://checkout.revolut.com/pay/ancien" } });
    await prisma.paymentMilestone.update({ where: { id: deposit.id }, data: { checkoutUrl: "https://checkout.revolut.com/pay/ancien", status: MilestoneStatus.DUE } });
    const other = await signedQuote();
    const ok = await generateMilestoneInvoice((await prisma.paymentMilestone.findFirstOrThrow({ where: { quoteId: other, position: 1 } })).id);
    await prisma.invoice.update({ where: { id: ok.id }, data: { checkoutUrl: "https://api.kouzia.test/api/public/pay/jeton" } });
    const before = await prisma.invoice.findMany({ orderBy: { id: "asc" } });
    const milestonesBefore = await prisma.paymentMilestone.findMany({ orderBy: { id: "asc" } });

    expect(await reportForeignPaymentLinks()).toBe(2);
    const alerts = await prisma.emailOutbox.findMany({ where: { reviewKind: "payment_link_foreign" } });
    expect(alerts.map((a) => a.documentId).sort()).toEqual([deposit.id, inv.id].sort());
    // Une seule fois : un second passage ne signale plus rien.
    expect(await reportForeignPaymentLinks()).toBe(0);
    expect(await prisma.emailOutbox.count({ where: { reviewKind: "payment_link_foreign" } })).toBe(2);
    // Rien n'est modifié.
    expect(await prisma.invoice.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    expect(await prisma.paymentMilestone.findMany({ orderBy: { id: "asc" } })).toEqual(milestonesBefore);

    // Notification (cloche, et push) qui renvoie vers le document.
    const items = (await listNotifications(since)).filter((i) => i.kind === "payment_link_foreign");
    expect(items.map((i) => i.href).sort()).toEqual([`/invoices/${inv.id}`, `/quotes/${quoteId}`].sort());
    expect(items.every((i) => i.body.includes("checkout.revolut.com"))).toBe(true);
  });
});
