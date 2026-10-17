import { prisma } from "@/lib/prisma.js";
import { withImapClient } from "@/lib/email/sync/imap-connection.js";
import { countUnreadInThread, refreshFolderUnread } from "@/lib/email/sync/folder-sync.js";

async function recountUnread(threadId: string | null, folderId: string | null): Promise<void> {
  if (threadId) {
    await prisma.emailThread.update({
      where: { id: threadId },
      data: { unreadCount: await countUnreadInThread(threadId) },
    });
  }
  await refreshFolderUnread([folderId]);
}

/** Résout un id ERP, un Message-ID RFC, ou un uid IMAP local. */
export async function resolveEmailMessageId(id: string): Promise<string | null> {
  const byPk = await prisma.emailMessage.findUnique({
    where: { id },
    select: { id: true },
  });
  if (byPk) return byPk.id;

  const byRfc = await prisma.emailMessage.findUnique({
    where: { messageId: id },
    select: { id: true },
  });
  if (byRfc) return byRfc.id;

  const asUid = Number(id);
  if (Number.isInteger(asUid) && asUid > 0) {
    const byUid = await prisma.emailMessage.findFirst({
      where: { imapUid: asUid, orphaned: false },
      select: { id: true },
      orderBy: { receivedAt: "desc" },
    });
    if (byUid) return byUid.id;
  }

  return null;
}

export async function setMessageFlags(
  messageId: string,
  flags: { read?: boolean; starred?: boolean },
): Promise<boolean> {
  const resolvedId = (await resolveEmailMessageId(messageId)) ?? messageId;
  const message = await prisma.emailMessage.findUnique({
    where: { id: resolvedId },
    include: { folder: true },
  });
  if (!message) return false;

  const data: { isRead?: boolean; isStarred?: boolean } = {};
  const imapAdd: string[] = [];
  const imapRemove: string[] = [];

  if (flags.read !== undefined) {
    data.isRead = flags.read;
    if (flags.read) imapAdd.push("\\Seen");
    else imapRemove.push("\\Seen");
  }
  if (flags.starred !== undefined) {
    data.isStarred = flags.starred;
    if (flags.starred) imapAdd.push("\\Flagged");
    else imapRemove.push("\\Flagged");
  }

  if (Object.keys(data).length === 0) return true;

  const onServer = Boolean(message.folder && message.imapUid);
  /* Local d'abord : l'UI ne doit pas attendre IMAP. flagsPending protège ce choix d'une synchro
     concurrente et fait réessayer l'écriture IMAP au passage suivant si elle échoue ici. */
  await prisma.emailMessage.update({ where: { id: message.id }, data: { ...data, ...(onServer ? { flagsPending: true } : {}) } });
  await recountUnread(
    flags.read !== undefined ? message.threadId : null,
    flags.read !== undefined ? message.folderId : null,
  );

  if (onServer) {
    try {
      await withImapClient(async ({ client }) => {
        await client.mailboxOpen(message.folder!.imapPath);
        if (imapAdd.length) {
          await client.messageFlagsAdd(String(message.imapUid), imapAdd, { uid: true });
        }
        if (imapRemove.length) {
          await client.messageFlagsRemove(String(message.imapUid), imapRemove, { uid: true });
        }
      });
      // Écrit sur le serveur, et pas de nouveau changement entre-temps : plus rien à pousser.
      await prisma.emailMessage.updateMany({
        where: { id: message.id, flagsPending: true, ...data },
        data: { flagsPending: false },
      });
    } catch {
      /* IMAP injoignable : flagsPending reste vrai, la prochaine synchro écrit l'état sur le serveur. */
    }
  }

  return true;
}

export async function setBulkMessageFlags(
  messageIds: string[],
  flags: { read?: boolean; starred?: boolean },
): Promise<number> {
  let count = 0;
  for (const id of messageIds) {
    const ok = await setMessageFlags(id, flags);
    if (ok) count++;
  }
  return count;
}
