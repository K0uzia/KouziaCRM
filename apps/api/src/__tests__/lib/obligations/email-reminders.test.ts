import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObligationStatus, ObligationType } from "@prisma/client";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings, prisma } from "../../helpers/factories.js";

vi.mock("@/lib/email/smtp.js", () => ({
  isSmtpConfigured: vi.fn(async () => true),
}));

vi.mock("@/lib/email/mailer/index.js", () => ({
  mailEnqueue: vi.fn(async () => ({ outboxId: "outbox-1", messageId: "<x@y>" })),
}));

import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { sendDueObligationEmails } from "@/lib/obligations/email-reminders.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  vi.mocked(mailEnqueue).mockClear();
});

afterEach(async () => {
  await resetDb();
});

describe("sendDueObligationEmails idempotence", () => {
  it("n'envoie qu'une fois par stage / obligation", async () => {
    const due = new Date();
    due.setHours(12, 0, 0, 0);

    const obl = await prisma.obligation.create({
      data: {
        type: ObligationType.URSSAF_DECLARATION,
        period: "2026-03",
        dueDate: due,
        status: ObligationStatus.PENDING,
        label: "Déclaration URSSAF : mars 2026",
      },
    });

    const first = await sendDueObligationEmails(due);
    expect(first).toBe(1);
    expect(mailEnqueue).toHaveBeenCalledTimes(1);

    const second = await sendDueObligationEmails(due);
    expect(second).toBe(0);
    expect(mailEnqueue).toHaveBeenCalledTimes(1);

    const logs = await prisma.obligationReminderLog.findMany({
      where: { obligationId: obl.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.stage).toBe("j0");
  });
});
