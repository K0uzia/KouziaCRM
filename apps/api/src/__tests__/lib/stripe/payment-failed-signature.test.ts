import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));
vi.mock("@/lib/stripe/alert.js", () => ({ alertAdmin: vi.fn(async () => undefined) }));

const { mailEnqueue } = await import("@/lib/email/mailer/index.js");
const { notifyInvoicePaymentFailed, notifyMilestonePaymentFailed } = await import("@/lib/stripe/payment-processing.js");

const SIGNATURE = "Bien à vous,\nAlexandre";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { emailSignatureHtml: "<p>Bien à vous,<br>Alexandre</p>" } });
  (await import("@/lib/company.js")).invalidateCompanySettingsCache();
  vi.mocked(mailEnqueue).mockClear();
});

const pi = (metadata: Record<string, string>) =>
  ({ id: "pi_test", amount: 30_000, metadata, payment_method: null, payment_method_types: ["sepa_debit"], last_payment_error: null }) as unknown as Stripe.PaymentIntent;

async function clientWithEmail() {
  const c = await createClient({ displayName: "Lou Martin" });
  await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt("lou@example.test") } });
  return c;
}

describe("e-mails d'échec de paiement : signature des Réglages (M0)", () => {
  it("échéance de devis refusée après coup : le texte finit par la signature", async () => {
    const c = await clientWithEmail();
    const quote = await prisma.invoice.create({
      data: { documentType: "QUOTE", quoteStatus: "ACCEPTED", status: "ISSUED", number: "D-2026-0700", clientId: c.id, subtotalCents: 100_000, totalCents: 100_000 },
    });
    const milestone = await prisma.paymentMilestone.create({
      data: { quoteId: quote.id, position: 1, label: "Acompte", percentBps: 3000, amountCents: 30_000, triggerText: "À la signature", status: "DUE" },
    });
    expect(await notifyMilestonePaymentFailed(pi({ erpMilestoneId: milestone.id }), true)).toBe("échec signalé");
    const mail = vi.mocked(mailEnqueue).mock.calls[0]![0];
    expect(mail.kind).toBe("payment_failed");
    expect((mail.text ?? "").trimEnd().endsWith(SIGNATURE)).toBe(true);
  });

  it("facture dont le prélèvement était en cours : le texte finit par la signature", async () => {
    const c = await clientWithEmail();
    const invoice = await prisma.invoice.create({
      data: { documentType: "INVOICE", status: "ISSUED", number: "F-2026-0700", clientId: c.id, subtotalCents: 30_000, totalCents: 30_000, paymentProcessingAt: new Date() },
    });
    await notifyInvoicePaymentFailed(pi({ erpInvoiceId: invoice.id }));
    const mail = vi.mocked(mailEnqueue).mock.calls.map((call) => call[0]).find((m) => m.kind === "payment_failed");
    expect(mail).toBeDefined();
    expect((mail!.text ?? "").trimEnd().endsWith(SIGNATURE)).toBe(true);
  });
});
