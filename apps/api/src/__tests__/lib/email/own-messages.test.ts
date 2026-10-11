import { beforeEach, describe, expect, it } from "vitest";
import { EmailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import { isOwnOutboundMessage, readOutboundHeader } from "@/lib/email/own-messages.js";
import { listNotifications } from "@/lib/notifications/feed.js";
import { setBulkMessageFlags } from "@/lib/email/sync/flag-sync.js";
import { resetDb } from "../../helpers/db.js";
import { createClient, seedCompanySettings } from "../../helpers/factories.js";

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
  await prisma.companySettings.updateMany({ data: { smtpFrom: "Kouzia <contact@kouzia.test>", smtpUser: "contact@kouzia.test" } });
  invalidateCompanySettingsCache();
});

describe("e-mails envoyés par l'ERP", () => {
  it("reconnus seulement par l'en-tête maison ou le Message-ID de l'ERP", () => {
    expect(isOwnOutboundMessage({ messageId: "<a@b>", outboundHeader: "1" })).toBe(true);
    expect(isOwnOutboundMessage({ messageId: "<cuid123@kouzia.local>" })).toBe(true);
    expect(isOwnOutboundMessage({ messageId: "<z@gmail.com>" })).toBe(false);
  });

  it("vrai e-mail reçu depuis notre propre adresse (envoi à soi-même, formulaire relayé) : reçu, pas envoi", () => {
    // En-têtes d'un message du formulaire du site relayé par Web3Forms vers contact@, From = contact@.
    const web3forms = [
      "From: Kouzia <contact@kouzia.com>",
      "Reply-To: prospect@gmail.com",
      "To: contact@kouzia.com",
      "Subject: Nouveau message depuis kouzia.com",
      "Message-ID: <0102019a1b2c3d4e-5f6a7b8c@email.amazonses.com>",
      "",
      "",
    ].join("\r\n");
    expect(readOutboundHeader(web3forms)).toBeNull();
    expect(
      isOwnOutboundMessage({
        messageId: "<0102019a1b2c3d4e-5f6a7b8c@email.amazonses.com>",
        outboundHeader: readOutboundHeader(web3forms),
      }),
    ).toBe(false);
    // Envoi direct de contact@ vers contact@ depuis le webmail Hostinger.
    expect(isOwnOutboundMessage({ messageId: "<a1b2c3@kouzia.com>", outboundHeader: null })).toBe(false);
  });

  it("lecture de l'en-tête dans le bloc brut IMAP", () => {
    expect(readOutboundHeader(Buffer.from("X-Kouzia-Outbound: 1\r\n\r\n"))).toBe("1");
    expect(readOutboundHeader("x-kouzia-outbound:   1\r\n")).toBe("1");
    expect(readOutboundHeader("Subject: test\r\n")).toBeNull();
    expect(readOutboundHeader(undefined)).toBeNull();
  });

  it("le flux ne notifie pas un envoi de l'ERP synchronisé comme reçu", async () => {
    const since = new Date(Date.now() - 1000);
    const client = await createClient();
    const thread = await prisma.emailThread.create({
      data: { subject: "Fiche client", participants: "[]", lastMessageAt: new Date(), clientId: client.id },
    });
    const base = { threadId: thread.id, direction: EmailDirection.INBOUND, toAddresses: "[]", receivedAt: new Date() };
    await prisma.emailMessage.create({
      data: { ...base, messageId: "<outbox1@kouzia.local>", fromAddress: "x@y.fr", subject: "Complétez votre fiche" },
    });
    await prisma.emailMessage.create({
      data: { ...base, messageId: "<m2@hostinger>", fromAddress: "contact@kouzia.test", subject: "Votre code" },
    });
    await prisma.emailMessage.create({
      data: { ...base, messageId: "<m3@gmail.com>", fromAddress: "client@gmail.com", subject: "Question du client" },
    });
    const mails = (await listNotifications(since)).filter((i) => i.kind === "mail");
    // Seul le Message-ID de l'ERP exclut : un message reçu de contact@ reste notifié.
    expect(mails.map((m) => m.body).sort()).toEqual([
      "client@gmail.com : Question du client",
      "contact@kouzia.test : Votre code",
    ]);
  });
});

describe("état lu : une seule source (base)", () => {
  it("marquer les messages notifiés comme lus remet le compteur du fil à zéro", async () => {
    const client = await createClient();
    const thread = await prisma.emailThread.create({
      data: { subject: "Q", participants: "[]", lastMessageAt: new Date(), clientId: client.id, unreadCount: 2 },
    });
    const base = {
      threadId: thread.id,
      direction: EmailDirection.INBOUND,
      toAddresses: "[]",
      receivedAt: new Date(),
      fromAddress: "client@gmail.com",
      subject: "Q",
      isRead: false,
    };
    const a = await prisma.emailMessage.create({ data: { ...base, messageId: "<a@gmail.com>" } });
    const b = await prisma.emailMessage.create({ data: { ...base, messageId: "<b@gmail.com>" } });
    expect(await setBulkMessageFlags([a.id, b.id], { read: true })).toBe(2);
    const after = await prisma.emailThread.findUniqueOrThrow({ where: { id: thread.id } });
    expect(after.unreadCount).toBe(0);
  });
});
