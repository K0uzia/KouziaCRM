import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { EmailDirection } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findClientIdByEmail } from "@/lib/email/match-client";
import { resetRemindersForMatchedDocuments } from "@/lib/reminders";

export function isImapConfigured(): boolean {
  return Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

function normalizeSubject(subject: string): string {
  return subject.replace(/^(re|fw|fwd|tr|transfert)\s*:\s*/gi, "").trim().toLowerCase();
}

function parseAddressList(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return [value.toLowerCase()];
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === "string") return v.toLowerCase();
        if (v && typeof v === "object" && "address" in v) {
          return String((v as { address?: string }).address || "").toLowerCase();
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof value === "object" && value && "value" in value) {
    const list = (value as { value?: Array<{ address?: string }> }).value || [];
    return list.map((v) => (v.address || "").toLowerCase()).filter(Boolean);
  }
  return [];
}

async function resolveThreadId(opts: {
  messageId: string;
  inReplyTo: string | null;
  subject: string;
  participants: string[];
  clientId: string | null;
  receivedAt: Date;
}): Promise<string> {
  if (opts.inReplyTo) {
    const parent = await prisma.emailMessage.findUnique({
      where: { messageId: opts.inReplyTo },
      select: { threadId: true },
    });
    if (parent) return parent.threadId;
  }

  const normalized = normalizeSubject(opts.subject);
  const recent = await prisma.emailThread.findMany({
    take: 50,
    orderBy: { lastMessageAt: "desc" },
  });
  const match = recent.find((t) => normalizeSubject(t.subject) === normalized);
  if (match) {
    await prisma.emailThread.update({
      where: { id: match.id },
      data: {
        lastMessageAt: opts.receivedAt,
        clientId: match.clientId ?? opts.clientId,
        participants: JSON.stringify(
          Array.from(new Set([...JSON.parse(match.participants || "[]"), ...opts.participants])),
        ),
      },
    });
    return match.id;
  }

  const thread = await prisma.emailThread.create({
    data: {
      subject: opts.subject || "(sans objet)",
      participants: JSON.stringify(opts.participants),
      clientId: opts.clientId,
      lastMessageAt: opts.receivedAt,
    },
  });
  return thread.id;
}

export async function syncImapInbox(): Promise<{ imported: number; skipped: number }> {
  if (!isImapConfigured()) {
    console.warn("[imap] non configuré  -  skip");
    return { imported: 0, skipped: 0 };
  }

  const mailbox = process.env.IMAP_MAILBOX || "INBOX";
  const client = new ImapFlow({
    host: process.env.IMAP_HOST!,
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE !== "false",
    auth: {
      user: process.env.IMAP_USER!,
      pass: process.env.IMAP_PASS!,
    },
    logger: false,
  });

  let imported = 0;
  let skipped = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const state = await prisma.emailSyncState.upsert({
        where: { mailbox },
        create: { mailbox, lastUid: 0 },
        update: {},
      });

      const range = state.lastUid > 0 ? `${state.lastUid + 1}:*` : "1:*";
      let maxUid = state.lastUid;

      for await (const msg of client.fetch(range, { uid: true, source: true })) {
        if (!msg.source || !msg.uid) continue;
        if (msg.uid <= state.lastUid) continue;

        const parsed = await simpleParser(msg.source);
        const messageId = parsed.messageId || `uid-${mailbox}-${msg.uid}@local`;
        const existing = await prisma.emailMessage.findUnique({ where: { messageId } });
        if (existing) {
          skipped += 1;
          maxUid = Math.max(maxUid, msg.uid);
          continue;
        }

        const fromAddress =
          parsed.from?.value?.[0]?.address?.toLowerCase() ||
          parsed.from?.text?.toLowerCase() ||
          "unknown";
        const toAddresses = parseAddressList(parsed.to);
        const subject = parsed.subject || "(sans objet)";
        const inReplyTo = parsed.inReplyTo
          ? Array.isArray(parsed.inReplyTo)
            ? parsed.inReplyTo[0]
            : parsed.inReplyTo
          : null;
        const receivedAt = parsed.date || new Date();
        const participants = Array.from(new Set([fromAddress, ...toAddresses]));
        const clientId = await findClientIdByEmail(fromAddress);

        const threadId = await resolveThreadId({
          messageId,
          inReplyTo,
          subject,
          participants,
          clientId,
          receivedAt,
        });

        await prisma.emailMessage.create({
          data: {
            threadId,
            direction: EmailDirection.INBOUND,
            messageId,
            inReplyTo,
            fromAddress,
            toAddresses: JSON.stringify(toAddresses),
            subject,
            bodyText: parsed.text || null,
            bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
            receivedAt,
            rawHeaders: JSON.stringify(parsed.headers || {}),
          },
        });

        await resetRemindersForMatchedDocuments(subject, parsed.text || null);

        imported += 1;
        maxUid = Math.max(maxUid, msg.uid);
      }

      await prisma.emailSyncState.update({
        where: { mailbox },
        data: { lastUid: maxUid, lastSyncedAt: new Date() },
      });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return { imported, skipped };
}
