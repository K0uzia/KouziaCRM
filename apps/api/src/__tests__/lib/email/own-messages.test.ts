import { beforeEach, describe, expect, it } from "vitest";
import { EmailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";
import {
  erpSenderAddresses,
  isOwnOutboundMessage,
  readOutboundHeader,
} from "@/lib/email/own-messages.js";
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
  it("adresses d'envoi lues dans les réglages, en minuscules et sans nom affiché", async () => {
    const senders = await erpSenderAddresses();
    expect(senders.has("contact@kouzia.test")).toBe(true);
  });

  it("reconnus par l'en-tête maison, le Message-ID de l'ERP ou l'expéditeur", () => {
    const senders = new Set(["contact@kouzia.test"]);
    expect(isOwnOutboundMessage({ fromAddress: "x@y.fr", messageId: "<a@b>", outboundHeader: "1" }, senders)).toBe(true);
    expect(isOwnOutboundMessage({ fromAddress: "x@y.fr", messageId: "<cuid123@kouzia.local>" }, senders)).toBe(true);
    expect(isOwnOutboundMessage({ fromAddress: "Contact@Kouzia.test", messageId: "<z@gmail.com>" }, senders)).toBe(true);
    expect(isOwnOutboundMessage({ fromAddress: "client@gmail.com", messageId: "<z@gmail.com>" }, senders)).toBe(false);
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
    expect(mails).toHaveLength(1);
    expect(mails[0]!.body).toContain("Question du client");
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
