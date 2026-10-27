import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailOutboxStatus, InvoiceDocumentType, InvoiceStatus, QuoteStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { encrypt } from "@/lib/crypto.js";
import { resetDb } from "../helpers/db.js";
import { createClient, seedCompanySettings } from "../helpers/factories.js";

// Audit du 27/10/2026 (P0) : une relance en attente de validation remet nextReminderAt à null ; au passage horaire
// suivant, scheduleReminders (appelée avant sendDueReminders par le worker) reprend les nextReminderAt nuls et les
// replanifie à maintenant : une copie de plus par heure dans « E-mails à valider », envoyées toutes au client par
// « Valider tout ». Le test existant appelait sendDueReminders sans scheduleReminders entre deux passages.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
}));
const { scheduleReminders } = await import("@/lib/reminders.js");
const { sendDueReminders } = await import("@/lib/reminders/send.js");
const { approveReviewEmail } = await import("@/lib/email/review.js");

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.emailOutbox.deleteMany();
});

async function overdueInvoice() {
  const c = await createClient({ displayName: "Lou Martin", type: "B2C" });
  await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt("lou@example.com") } });
  return prisma.invoice.create({
    data: {
      clientId: c.id,
      documentType: InvoiceDocumentType.INVOICE,
      status: InvoiceStatus.ISSUED,
      number: "F-2026-0101",
      subtotalCents: 50_000,
      totalCents: 50_000,
      issueDate: new Date("2026-09-01T10:00:00Z"),
      dueDate: new Date("2026-09-15T10:00:00Z"),
    },
  });
}

/** Un passage du worker : planification puis envoi, comme runMaintenance. */
async function hourlyPass(at: Date) {
  await scheduleReminders(at);
  return sendDueReminders(at);
}

describe("relance en attente de validation : une seule, jamais recopiée", () => {
  it("facture en retard : trois passages horaires, une seule relance à valider", async () => {
    const inv = await overdueInvoice();
    const t0 = new Date("2026-10-20T09:00:00Z");
    await hourlyPass(t0);
    await hourlyPass(new Date(t0.getTime() + 3_600_000));
    await hourlyPass(new Date(t0.getTime() + 2 * 3_600_000));
    const open = await prisma.emailOutbox.count({ where: { documentId: inv.id, status: EmailOutboxStatus.REVIEW } });
    expect(open).toBe(1);
  });

  it("relance en attente puis facture payée : la validation la retire au lieu de l'envoyer", async () => {
    const inv = await overdueInvoice();
    await hourlyPass(new Date("2026-10-20T09:00:00Z"));
    const row = await prisma.emailOutbox.findFirstOrThrow({ where: { documentId: inv.id, status: EmailOutboxStatus.REVIEW } });
    await prisma.invoice.update({ where: { id: inv.id }, data: { status: InvoiceStatus.PAID } });
    await approveReviewEmail(row.id).catch(() => undefined);
    const after = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe(EmailOutboxStatus.REJECTED);
  });

  it("devis envoyé : trois passages horaires, une seule relance à valider", async () => {
    const c = await createClient({ displayName: "Noa Dupont", type: "B2B" });
    await prisma.client.update({ where: { id: c.id }, data: { emailEncrypted: encrypt("noa@example.com") } });
    const q = await prisma.invoice.create({
      data: {
        clientId: c.id,
        documentType: InvoiceDocumentType.QUOTE,
        status: InvoiceStatus.ISSUED,
        quoteStatus: QuoteStatus.SENT,
        number: "D-2026-0101",
        subtotalCents: 50_000,
        totalCents: 50_000,
        issueDate: new Date("2026-09-01T10:00:00Z"),
        issuedAt: new Date("2026-09-01T10:00:00Z"),
      },
    });
    const t0 = new Date("2026-10-20T09:00:00Z");
    for (let h = 0; h < 3; h++) await hourlyPass(new Date(t0.getTime() + h * 3_600_000));
    expect(await prisma.emailOutbox.count({ where: { documentId: q.id, status: EmailOutboxStatus.REVIEW } })).toBe(1);
  });
});
