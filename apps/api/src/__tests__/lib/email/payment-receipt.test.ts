import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outboxPayloadRaw } from "@/lib/privacy/at-rest.js";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";
import { issueInvoice } from "@/lib/invoices/transitions.js";
import { parsePayload } from "@/lib/email/mailer/outbox.js";

// SMTP « configuré » : l'email part dans la file d'envoi, jamais sur le réseau (pas de worker).
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));

const { sendPaymentReceipt } = await import("@/lib/email/payment-receipt.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.emailOutbox.deleteMany();
});

afterEach(async () => {
  await resetDb();
});

async function issuedInvoice() {
  const client = await createClient({ displayName: "Lou Essai" });
  await prisma.client.update({
    where: { id: client.id },
    data: { emailEncrypted: encrypt("lou@example.test") },
  });
  const inv = await prisma.invoice.create({
    data: {
      documentType: "INVOICE",
      invoiceType: "SIMPLE",
      status: "DRAFT",
      clientId: client.id,
      subtotalCents: 119000,
      totalCents: 119000,
      lines: {
        create: [{ position: 0, description: "Site vitrine", quantity: 1, unitPriceCents: 119000, lineTotalCents: 119000 }],
      },
    },
  });
  return issueInvoice(inv.id);
}

describe("reçu de paiement", () => {
  it("soldée : la facture (telle qu'émise) et le reçu du règlement en pièces jointes", async () => {
    const inv = await issuedInvoice();
    await prisma.payment.create({
      data: { invoiceId: inv.id, amountCents: 119000, paidAt: new Date(), method: "BANK_TRANSFER" },
    });
    await prisma.invoice.update({ where: { id: inv.id }, data: { status: "PAID" } });

    const res = await sendPaymentReceipt(inv.id, 119000);
    expect(res.sent).toBe(true);
    const row = await prisma.emailOutbox.findFirstOrThrow();
    const payload = parsePayload(outboxPayloadRaw(row));
    expect(payload.to).toBe("lou@example.test");
    expect(payload.subject).toBe(`Paiement reçu : facture ${inv.number} réglée`);
    expect(payload.text).toContain("1 190,00 €");
    expect(payload.text).toContain("La facture est entièrement réglée.");
    expect(payload.text).not.toContain("acquittée");
    expect(payload.attachments?.[0]?.filename).toMatch(/^Facture_.*\.pdf$/);
    expect(payload.attachments?.[1]?.filename).toMatch(/^Recu-.*\.pdf$/);
    expect(payload.html).toContain("Nous avons bien reçu votre paiement");
  });

  it("indique le reste dû après un paiement partiel", async () => {
    const inv = await issuedInvoice();
    await prisma.payment.create({
      data: { invoiceId: inv.id, amountCents: 50000, paidAt: new Date(), method: "BANK_TRANSFER" },
    });
    await sendPaymentReceipt(inv.id, 50000);
    const payload = parsePayload(outboxPayloadRaw(await prisma.emailOutbox.findFirstOrThrow()));
    expect(payload.text).toContain("Il reste 690,00 € à régler");
  });
});
