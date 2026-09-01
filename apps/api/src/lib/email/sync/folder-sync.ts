import {
  EmailDirection,
  MailFolderRole,
  type MailFolder,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { findClientIdByEmail } from "@/lib/email/match-client.js";
import {
  buildFolderOverrides,
  detectFolderRole,
  folderDisplayName,
} from "@/lib/email/sync/folder-mapper.js";
import { hasImapFlag, toImapInt, toUidValidity } from "@/lib/email/sync/imap-int.js";
import { withImapClient } from "@/lib/email/sync/imap-connection.js";
import { ensureMailAccount } from "@/lib/email/sync/sync-status.js";
import { normalizeSubject, parseAddressList } from "@/lib/email/sync/threading.js";
import type { ImapFlow } from "imapflow";

type EnvelopeLike = {
  messageId?: string;
  inReplyTo?: string;
  subject?: string;
  date?: Date;
  from?: Array<{ address?: string; name?: string }>;
  to?: Array<{ address?: string; name?: string }>;
  cc?: Array<{ address?: string; name?: string }>;
};

function envelopeFrom(raw: unknown): EnvelopeLike {
  if (!raw || typeof raw !== "object") return {};
  return raw as EnvelopeLike;
}

/** Certains serveurs (ex. Dovecot) renvoient BAD sur FETCH si la plage UID est vide. */
function hasUidRange(mailbox: { uidNext?: bigint | number | null; exists?: number }, fromUid: number): boolean {
  if ((mailbox.exists ?? 0) === 0) return false;
  const uidNext = toImapInt(mailbox.uidNext);
  if (uidNext > 0 && fromUid >= uidNext) return false;
  return fromUid > 0;
}

async function reconcileOrphanedMessages(folderId: string, client: ImapFlow): Promise<number> {
  const orphaned = await prisma.emailMessage.findMany({
    where: { folderId, orphaned: true, imapUid: { not: null } },
    select: { id: true, imapUid: true },
  });
  if (orphaned.length === 0) return 0;

  const uidSet = orphaned
    .map((m) => toImapInt(m.imapUid))
    .filter((uid) => uid > 0)
    .join(",");
  if (!uidSet) return 0;

  let reconciled = 0;
  for await (const msg of client.fetch(uidSet, { uid: true, flags: true }, { uid: true })) {
    const uid = toImapInt(msg.uid);
    if (!uid) continue;
    const existing = orphaned.find((m) => toImapInt(m.imapUid) === uid);
    if (!existing) continue;
    const isRead = hasImapFlag(msg.flags, "Seen");
    const isStarred = hasImapFlag(msg.flags, "Flagged");
    await prisma.emailMessage.update({
      where: { id: existing.id },
      data: { isRead, isStarred, orphaned: false },
    });
    reconciled++;
  }
  return reconciled;
}

function messageIdFromEnvelope(env: EnvelopeLike, uid: number, path: string): string {
  return env.messageId?.trim() || `uid-${path}-${uid}@local`;
}

async function resolveThreadId(opts: {
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
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

  if (opts.references) {
    const refs = opts.references.split(/\s+/).filter(Boolean);
    for (const ref of refs.reverse()) {
      const parent = await prisma.emailMessage.findUnique({
        where: { messageId: ref },
        select: { threadId: true },
      });
      if (parent) return parent.threadId;
    }
  }

  const normalized = normalizeSubject(opts.subject);
  const recent = await prisma.emailThread.findMany({
    take: 100,
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
          Array.from(
            new Set([...JSON.parse(match.participants || "[]"), ...opts.participants]),
          ),
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
      unreadCount: 1,
    },
  });
  return thread.id;
}

async function upsertFolderFromServer(opts: {
  accountId: string;
  imapPath: string;
  role: MailFolderRole;
}): Promise<MailFolder> {
  return prisma.mailFolder.upsert({
    where: {
      accountId_imapPath: {
        accountId: opts.accountId,
        imapPath: opts.imapPath,
      },
    },
    create: {
      accountId: opts.accountId,
      imapPath: opts.imapPath,
      displayName: folderDisplayName(opts.imapPath, opts.role),
      role: opts.role,
    },
    update: {
      displayName: folderDisplayName(opts.imapPath, opts.role),
      role: opts.role,
    },
  });
}

export async function discoverAndEnsureFolders(): Promise<MailFolder[]> {
  const account = await ensureMailAccount();
  const settings = await getCompanySettings();
  const overrides = buildFolderOverrides(settings);

  return withImapClient(async ({ client }) => {
    const listed = await client.list();
    const paths = listed.map((m) => m.path).filter(Boolean);
    const folders: MailFolder[] = [];

    const forcedPaths = new Set<string>();
    for (const path of Object.values(overrides)) {
      if (path) forcedPaths.add(path);
    }
    if (forcedPaths.size === 0 && !paths.includes("INBOX")) {
      paths.unshift("INBOX");
    }

    const allPaths = Array.from(new Set([...paths, ...forcedPaths]));
    for (const imapPath of allPaths) {
      if (!imapPath) continue;
      const role = detectFolderRole(imapPath, overrides);
      folders.push(await upsertFolderFromServer({ accountId: account.id, imapPath, role }));
    }

    return folders;
  });
}

export async function syncFolder(folderId: string): Promise<{ imported: number; updated: number }> {
  const folder = await prisma.mailFolder.findUniqueOrThrow({ where: { id: folderId } });
  if (folder.isVirtual) return { imported: 0, updated: 0 };

  let imported = 0;
  let updated = 0;

  await withImapClient(async ({ client }) => {
    const mailbox = await client.mailboxOpen(folder.imapPath);
    const uidValidity = toUidValidity(mailbox.uidValidity);

    if (folder.uidValidity > 0 && folder.uidValidity !== uidValidity) {
      await prisma.mailFolder.update({
        where: { id: folder.id },
        data: { uidValidity, highestUid: 0 },
      });
      await prisma.emailMessage.updateMany({
        where: { folderId: folder.id },
        data: { orphaned: true },
      });
      folder.highestUid = 0;
      folder.uidValidity = uidValidity;
    }

    const startUid = folder.highestUid > 0 ? folder.highestUid + 1 : 1;
    let maxUid = folder.highestUid;
    let folderUnread = 0;

    if (hasUidRange(mailbox, startUid)) {
      for await (const msg of client.fetch(
        `${startUid}:*`,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          size: true,
        },
        { uid: true },
      )) {
        const uid = toImapInt(msg.uid);
        if (!uid) continue;
        if (uid < startUid) continue;

        const env = envelopeFrom(msg.envelope);
        const mid = messageIdFromEnvelope(env, uid, folder.imapPath);
        const fromAddress =
          env.from?.[0]?.address?.toLowerCase() ||
          env.from?.[0]?.name?.toLowerCase() ||
          "unknown";
        const fromName = env.from?.[0]?.name?.trim() || null;
        const toAddresses = parseAddressList(env.to);
        const ccAddresses = parseAddressList(env.cc);
        const subject = env.subject || "(sans objet)";
        const inReplyTo = env.inReplyTo?.trim() || null;
        const receivedAt = env.date || new Date();
        const isRead = hasImapFlag(msg.flags, "Seen");
        const isStarred = hasImapFlag(msg.flags, "Flagged");
        const hasAttachments = Boolean(
          msg.bodyStructure &&
            typeof msg.bodyStructure === "object" &&
            "childNodes" in (msg.bodyStructure as object),
        );

        const existing = await prisma.emailMessage.findFirst({
          where: { folderId: folder.id, imapUid: uid },
        });

        if (existing) {
          const mergedRead = existing.isRead || isRead;
          if (
            existing.isRead !== mergedRead ||
            existing.isStarred !== isStarred ||
            existing.orphaned
          ) {
            await prisma.emailMessage.update({
              where: { id: existing.id },
              data: { isRead: mergedRead, isStarred, orphaned: false },
            });
            updated++;
          }
          maxUid = Math.max(maxUid, uid);
          if (!mergedRead) folderUnread++;
          continue;
        }

        const byMessageId = await prisma.emailMessage.findUnique({ where: { messageId: mid } });
        if (byMessageId) {
          await prisma.emailMessage.update({
            where: { id: byMessageId.id },
            data: {
              folderId: folder.id,
              imapUid: uid,
              isRead: byMessageId.isRead || isRead,
              isStarred,
              orphaned: false,
            },
          });
          maxUid = Math.max(maxUid, uid);
          if (!(byMessageId.isRead || isRead)) folderUnread++;
          updated++;
          continue;
        }

        const participants = Array.from(new Set([fromAddress, ...toAddresses, ...ccAddresses]));
        const clientId = await findClientIdByEmail(fromAddress);
        const direction =
          folder.role === MailFolderRole.SENT ? EmailDirection.OUTBOUND : EmailDirection.INBOUND;

        const threadId = await resolveThreadId({
          messageId: mid,
          inReplyTo,
          references: null,
          subject,
          participants,
          clientId,
          receivedAt,
        });

        await prisma.emailMessage.create({
          data: {
            threadId,
            folderId: folder.id,
            direction,
            messageId: mid,
            inReplyTo,
            fromAddress,
            fromName,
            toAddresses: JSON.stringify(toAddresses),
            ccAddresses: ccAddresses.length ? JSON.stringify(ccAddresses) : null,
            subject,
            snippet: subject.slice(0, 120),
            receivedAt,
            isRead,
            isStarred,
            hasAttachments,
            imapUid: uid,
            bodyFetched: false,
          },
        });

        if (!isRead) {
          await prisma.emailThread.update({
            where: { id: threadId },
            data: { unreadCount: { increment: 1 } },
          });
        }

        imported++;
        maxUid = Math.max(maxUid, uid);
        if (!isRead) folderUnread++;
      }
    }

    updated += await reconcileOrphanedMessages(folder.id, client);
    updated += await orphanUidsMissingOnServer(folder.id, client, mailbox.exists ?? 0);

    if (startUid === 1 && maxUid === folder.highestUid) {
      const status = await client.status(folder.imapPath, { unseen: true });
      folderUnread = toImapInt(status.unseen) || folderUnread;
    } else if (!hasUidRange(mailbox, startUid)) {
      const status = await client.status(folder.imapPath, { unseen: true });
      folderUnread = toImapInt(status.unseen) || folderUnread;
    }

    const unreadLocal = await prisma.emailMessage.count({
      where: { folderId: folder.id, isRead: false, orphaned: false },
    });

    await prisma.mailFolder.update({
      where: { id: folder.id },
      data: {
        uidValidity,
        highestUid: toImapInt(maxUid),
        unreadCount: unreadLocal,
        lastSyncedAt: new Date(),
      },
    });
  });

  return { imported, updated };
}

/** Masque les copies locales absentes du serveur IMAP (ex. restes Mailpit). */
async function orphanUidsMissingOnServer(
  folderId: string,
  client: ImapFlow,
  exists: number,
): Promise<number> {
  const serverUids: number[] = [];
  if (exists > 0) {
    try {
      for await (const msg of client.fetch("1:*", { uid: true }, { uid: true })) {
        const uid = toImapInt(msg.uid);
        if (uid > 0) serverUids.push(uid);
      }
    } catch {
      return 0;
    }
  }

  const result = await prisma.emailMessage.updateMany({
    where: {
      folderId,
      orphaned: false,
      imapUid: serverUids.length > 0 ? { notIn: serverUids } : { not: null },
    },
    data: { orphaned: true },
  });
  return result.count;
}

export async function syncAllFolders(): Promise<{
  imported: number;
  updated: number;
  folders: number;
}> {
  const folders = await discoverAndEnsureFolders();
  let imported = 0;
  let updated = 0;

  for (const folder of folders.filter((f) => !f.isVirtual)) {
    const result = await syncFolder(folder.id);
    imported += result.imported;
    updated += result.updated;
  }

  return { imported, updated, folders: folders.length };
}

export async function pollFlagChanges(folderId: string): Promise<number> {
  const folder = await prisma.mailFolder.findUniqueOrThrow({ where: { id: folderId } });
  if (folder.isVirtual || folder.highestUid <= 0) return 0;

  const tracked = await prisma.emailMessage.findMany({
    where: {
      folderId: folder.id,
      imapUid: { not: null },
      orphaned: false,
    },
    select: { id: true, imapUid: true, isRead: true, isStarred: true },
    orderBy: { imapUid: "desc" },
    take: 200,
  });

  if (tracked.length === 0) return 0;

  let changed = 0;

  await withImapClient(async ({ client }) => {
    await client.mailboxOpen(folder.imapPath);
    const uidSet = tracked
      .map((m) => m.imapUid)
      .filter((uid): uid is number => typeof uid === "number" && uid > 0)
      .join(",");

    if (!uidSet) return;

    for await (const msg of client.fetch(uidSet, { uid: true, flags: true }, { uid: true })) {
      const uid = toImapInt(msg.uid);
      if (!uid) continue;
      const isRead = hasImapFlag(msg.flags, "Seen");
      const isStarred = hasImapFlag(msg.flags, "Flagged");
      const existing = tracked.find((m) => toImapInt(m.imapUid) === uid);
      if (!existing) continue;
      /* Ne pas rétrograder un lu local : \Seen IMAP peut arriver en retard. */
      const mergedRead = existing.isRead || isRead;
      if (existing.isRead === mergedRead && existing.isStarred === isStarred) continue;
      await prisma.emailMessage.update({
        where: { id: existing.id },
        data: { isRead: mergedRead, isStarred },
      });
      changed++;
    }

    const unreadLocal = await prisma.emailMessage.count({
      where: { folderId: folder.id, isRead: false, orphaned: false },
    });
    await prisma.mailFolder.update({
      where: { id: folder.id },
      data: { unreadCount: unreadLocal },
    });
  });

  return changed;
}

type MessageWithFolder = Prisma.EmailMessageGetPayload<{ include: { folder: true } }>;

export async function resolveMessagesForDelete(id: string): Promise<MessageWithFolder[]> {
  const byPk = await prisma.emailMessage.findUnique({
    where: { id },
    include: { folder: true },
  });
  if (byPk) return [byPk];

  const byRfc = await prisma.emailMessage.findUnique({
    where: { messageId: id },
    include: { folder: true },
  });
  if (byRfc) return [byRfc];

  const inThread = await prisma.emailMessage.findMany({
    where: { threadId: id, orphaned: false },
    include: { folder: true },
  });
  if (inThread.length > 0) return inThread;

  const asUid = Number(id);
  if (Number.isInteger(asUid) && asUid > 0) {
    const byUid = await prisma.emailMessage.findFirst({
      where: { imapUid: asUid, orphaned: false },
      include: { folder: true },
    });
    if (byUid) return [byUid];
  }

  return [];
}

export async function moveMessageToFolder(
  messageId: string,
  targetFolderId: string,
): Promise<void> {
  const message = await prisma.emailMessage.findUnique({
    where: { id: messageId },
    include: { folder: true },
  });
  if (!message) return;
  if (!message.folder || !message.imapUid) {
    throw new Error("Message non synchronisé IMAP");
  }
  const target = await prisma.mailFolder.findUniqueOrThrow({ where: { id: targetFolderId } });

  await withImapClient(async ({ client }) => {
    await client.mailboxOpen(message.folder!.imapPath);
    await client.messageMove(String(message.imapUid), target.imapPath, { uid: true });
  });

  await prisma.emailMessage.update({
    where: { id: message.id },
    data: { folderId: target.id },
  });
}

async function deleteResolvedMessage(message: MessageWithFolder, permanent: boolean): Promise<void> {
  const trash = await prisma.mailFolder.findFirst({
    where: { role: MailFolderRole.TRASH, isVirtual: false },
  });

  if (!permanent && trash && message.folder?.role !== MailFolderRole.TRASH) {
    if (message.folder && message.imapUid) {
      try {
        await moveMessageToFolder(message.id, trash.id);
        return;
      } catch {
        /* IMAP indisponible : suppression locale ci-dessous. */
      }
    }
  }

  if (message.folder && message.imapUid) {
    try {
      await withImapClient(async ({ client }) => {
        await client.mailboxOpen(message.folder!.imapPath);
        await client.messageDelete(String(message.imapUid), { uid: true });
      });
    } catch {
      /* déjà absent côté IMAP */
    }
  }

  const threadId = message.threadId;
  await prisma.emailMessage.delete({ where: { id: message.id } }).catch(() => undefined);

  const remaining = await prisma.emailMessage.count({ where: { threadId } });
  if (remaining === 0) {
    await prisma.emailThread.delete({ where: { id: threadId } }).catch(() => undefined);
  }
}

export async function deleteMessage(
  messageId: string,
  permanent = false,
): Promise<{ deleted: number }> {
  const messages = await resolveMessagesForDelete(messageId);
  if (messages.length === 0) return { deleted: 0 };

  let deleted = 0;
  const seen = new Set<string>();
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    await deleteResolvedMessage(message, permanent);
    deleted++;
  }
  return { deleted };
}

export async function deleteMessages(
  messageIds: string[],
  permanent = false,
): Promise<{ deleted: number }> {
  let deleted = 0;
  const seen = new Set<string>();
  for (const id of messageIds) {
    const messages = await resolveMessagesForDelete(id);
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      await deleteResolvedMessage(message, permanent);
      deleted++;
    }
  }
  return { deleted };
}

export type MessageListFilter = {
  folderId?: string;
  virtual?: "unread" | "starred" | "attachments";
  audience?: "all" | "clients" | "external";
  clientId?: string;
  search?: string;
  starred?: boolean;
  unread?: boolean;
  hasAttachments?: boolean;
  skip?: number;
  take?: number;
};

export function buildMessageListWhere(filter: MessageListFilter): Prisma.EmailMessageWhereInput {
  const where: Prisma.EmailMessageWhereInput = {
    orphaned: false,
    imapUid: { not: null },
  };

  if (filter.folderId) where.folderId = filter.folderId;
  if (filter.virtual === "unread" || filter.unread) where.isRead = false;
  if (filter.virtual === "starred" || filter.starred) where.isStarred = true;
  if (filter.virtual === "attachments" || filter.hasAttachments) where.hasAttachments = true;
  if (filter.clientId) {
    where.thread = { clientId: filter.clientId };
  } else if (filter.audience === "clients") {
    where.thread = { clientId: { not: null } };
  } else if (filter.audience === "external") {
    where.thread = { clientId: null };
  }

  if (filter.search?.trim()) {
    const q = filter.search.trim();
    where.OR = [
      { subject: { contains: q } },
      { fromAddress: { contains: q } },
      { snippet: { contains: q } },
      { bodyText: { contains: q } },
    ];
  }

  return where;
}
