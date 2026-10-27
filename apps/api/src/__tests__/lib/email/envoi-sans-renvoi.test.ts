import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

// Audit du 27/10/2026 : après un envoi SMTP réussi, une erreur dans les suites (fil supprimé entre-temps, base
// occupée) remontait au catch de processEmailOutbox, qui remettait l'e-mail en file : renvoyé jusqu'à 3 fois au client.
const sent: string[] = [];
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
  resolveFromAddress: async () => "Kouzia <contact@kouzia.test>",
  getSharedTransport: async () => ({
    sendMail: async (opts: { subject: string }) => {
      sent.push(opts.subject);
      return { messageId: `<${sent.length}@smtp>` };
    },
  }),
}));

const { enqueueEmail } = await import("@/lib/email/mailer/outbox.js");
const { processEmailOutbox } = await import("@/lib/email/mailer/processor.js");

beforeEach(async () => {
  sent.length = 0;
  await resetDb();
  await seedCompanySettings();
  await prisma.emailOutbox.deleteMany();
});

describe("e-mail envoyé : jamais renvoyé", () => {
  it("fil de discussion disparu après la mise en file : envoyé une fois, marqué envoyé, pas de renvoi", async () => {
    const { outboxId } = await enqueueEmail({ to: "client@example.com", subject: "Réponse", text: "Bonjour", kind: "reply", threadId: "fil-supprime-entre-temps" });
    await processEmailOutbox();
    await prisma.emailOutbox.updateMany({ where: { id: outboxId }, data: { scheduledAt: new Date(0) } });
    await processEmailOutbox();
    await processEmailOutbox();
    expect(sent).toEqual(["Réponse"]);
    expect((await prisma.emailOutbox.findUniqueOrThrow({ where: { id: outboxId } })).status).toBe(EmailOutboxStatus.SENT);
  });
});
