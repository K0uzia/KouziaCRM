import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { resetDb } from "../../helpers/db.js";
import { seedCompanySettings } from "../../helpers/factories.js";

type Sent = { from: string; replyTo?: string; headers: Record<string, string> };
const sent: Sent[] = [];
let rejectSender = false;

// Transport SMTP simulé : enregistre les envois, peut refuser l'expéditeur noreply@.
vi.mock("@/lib/email/smtp.js", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/smtp.js")>()),
  isSmtpConfigured: async () => true,
  resolveFromAddress: async () => "Kouzia <contact@kouzia.test>",
  getSharedTransport: async () => ({
    sendMail: async (opts: Sent) => {
      if (rejectSender && opts.from.includes("noreply@")) {
        throw Object.assign(new Error("553 5.7.1 Sender address rejected: not owned by user"), {
          responseCode: 553,
          response: "553 5.7.1 Sender address rejected: not owned by user",
        });
      }
      sent.push(opts);
      return { messageId: `<${sent.length}@smtp>` };
    },
  }),
}));

const { enqueueEmail } = await import("@/lib/email/mailer/outbox.js");
const { sendOutboxNow } = await import("@/lib/email/mailer/processor.js");

async function send(kind: string) {
  const { outboxId } = await enqueueEmail({ to: "client@example.com", subject: "Test", text: "Bonjour", kind });
  await sendOutboxNow(outboxId);
  return sent.at(-1)!;
}

beforeEach(async () => {
  sent.length = 0;
  rejectSender = false;
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({
    data: { transactionalFrom: "noreply@kouzia.test", smtpReplyTo: null, smtpFromName: "Kouzia" },
  });
  invalidateCompanySettingsCache();
});

describe("expéditeur des e-mails automatiques", () => {
  it("codes, invitation, accès et alertes partent de noreply@, réponses vers l'adresse habituelle", async () => {
    for (const kind of ["portal_code", "onboarding", "access", "portal_alert", "admin_alert"]) {
      const mail = await send(kind);
      expect(mail.from).toBe("Kouzia <noreply@kouzia.test>");
      expect(mail.replyTo).toBe("contact@kouzia.test");
    }
  });

  it("documents (devis, factures, reçus) : adresse habituelle", async () => {
    const mail = await send("document");
    expect(mail.from).toBe("Kouzia <contact@kouzia.test>");
  });

  it("tous les envois portent l'en-tête maison reconnu par la synchro IMAP", async () => {
    expect((await send("portal_code")).headers["X-Kouzia-Outbound"]).toBe("1");
    expect((await send("document")).headers["X-Kouzia-Outbound"]).toBe("1");
  });

  it("expéditeur noreply@ refusé par le serveur : l'e-mail part quand même depuis contact@", async () => {
    rejectSender = true;
    const mail = await send("portal_code");
    expect(mail.from).toBe("Kouzia <contact@kouzia.test>");
  });

  it("non réglé : tout part de l'adresse habituelle", async () => {
    await prisma.companySettings.updateMany({ data: { transactionalFrom: null } });
    invalidateCompanySettingsCache();
    expect((await send("portal_code")).from).toBe("Kouzia <contact@kouzia.test>");
  });
});

describe("message d'erreur d'un expéditeur refusé", () => {
  it("explique l'alias à créer et le repli automatique", async () => {
    const { formatSmtpError } = await vi.importActual<typeof import("@/lib/email/smtp.js")>("@/lib/email/smtp.js");
    const msg = formatSmtpError({ responseCode: 553, response: "553 5.7.1 Sender address rejected: not owned by user" });
    expect(msg).toMatch(/alias/);
    expect(msg).toMatch(/adresse habituelle/);
  });
});
