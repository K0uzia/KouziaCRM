import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { resetDb } from "../../../helpers/db.js";
import { seedCompanySettings } from "../../../helpers/factories.js";
import { deleteMessage, deleteMessages } from "@/lib/email/sync/folder-sync.js";
import { setMessageFlags } from "@/lib/email/sync/flag-sync.js";

async function createThreadWithMessage(opts: {
  messageId: string;
  isRead?: boolean;
}) {
  const thread = await prisma.emailThread.create({
    data: {
      subject: "Sujet test",
      participants: "[]",
      lastMessageAt: new Date(),
    },
  });
  const message = await prisma.emailMessage.create({
    data: {
      threadId: thread.id,
      direction: EmailDirection.INBOUND,
      messageId: opts.messageId,
      fromAddress: "client@example.com",
      toAddresses: JSON.stringify(["contact@example.com"]),
      subject: "Sujet test",
      receivedAt: new Date(),
      isRead: opts.isRead ?? false,
    },
  });
  return { thread, message };
}

beforeEach(async () => {
  await resetDb();
  await seedCompanySettings();
});

afterEach(async () => {
  await resetDb();
});

describe("deleteMessage", () => {
  it("supprime un message local sans IMAP et est idempotent", async () => {
    const { message } = await createThreadWithMessage({ messageId: "<one@test.local>" });
    const first = await deleteMessage(message.id);
    expect(first.deleted).toBe(1);
    expect(await prisma.emailMessage.findUnique({ where: { id: message.id } })).toBeNull();

    const second = await deleteMessage(message.id);
    expect(second.deleted).toBe(0);
  });

  it("accepte un id de fil et supprime tous les messages du fil", async () => {
    const { thread, message } = await createThreadWithMessage({ messageId: "<a@test.local>" });
    await prisma.emailMessage.create({
      data: {
        threadId: thread.id,
        direction: EmailDirection.OUTBOUND,
        messageId: "<b@test.local>",
        fromAddress: "contact@example.com",
        toAddresses: JSON.stringify(["client@example.com"]),
        subject: "Re: Sujet test",
        receivedAt: new Date(),
      },
    });

    const result = await deleteMessage(thread.id);
    expect(result.deleted).toBe(2);
    expect(await prisma.emailMessage.count({ where: { threadId: thread.id } })).toBe(0);
    expect(await prisma.emailThread.findUnique({ where: { id: thread.id } })).toBeNull();
    expect(await prisma.emailMessage.findUnique({ where: { id: message.id } })).toBeNull();
  });

  it("supprime toute une sélection sans planter sur un id absent", async () => {
    const a = await createThreadWithMessage({ messageId: "<sel-a@test.local>" });
    const b = await createThreadWithMessage({ messageId: "<sel-b@test.local>" });
    const result = await deleteMessages([a.message.id, "id-inconnu", b.thread.id]);
    expect(result.deleted).toBe(2);
  });
});

describe("setMessageFlags", () => {
  it("marque un message lu en local sans IMAP", async () => {
    const { message, thread } = await createThreadWithMessage({
      messageId: "<unread@test.local>",
      isRead: false,
    });
    const ok = await setMessageFlags(message.id, { read: true });
    expect(ok).toBe(true);
    const updated = await prisma.emailMessage.findUnique({ where: { id: message.id } });
    expect(updated?.isRead).toBe(true);
    const t = await prisma.emailThread.findUnique({ where: { id: thread.id } });
    expect(t?.unreadCount).toBe(0);
  });

  it("ignore un id inexistant", async () => {
    const ok = await setMessageFlags("id-absent", { read: true });
    expect(ok).toBe(false);
  });
});
