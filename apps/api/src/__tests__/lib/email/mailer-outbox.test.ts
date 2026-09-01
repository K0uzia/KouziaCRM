import { describe, expect, it, beforeEach } from "vitest";
import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { enqueueEmail, parsePayload } from "@/lib/email/mailer/outbox.js";

describe("mailer outbox", () => {
  beforeEach(async () => {
    await prisma.emailOutbox.deleteMany();
  });

  it("enqueue crée une entrée PENDING", async () => {
    const { outboxId, messageId } = await enqueueEmail({
      to: "test@example.com",
      subject: "Test",
      text: "Hello",
    });
    expect(outboxId).toBeTruthy();
    expect(messageId).toContain(outboxId);

    const row = await prisma.emailOutbox.findUnique({ where: { id: outboxId } });
    expect(row?.status).toBe(EmailOutboxStatus.PENDING);
    const payload = parsePayload(row!.payload);
    expect(payload.subject).toBe("Test");
  });
});
