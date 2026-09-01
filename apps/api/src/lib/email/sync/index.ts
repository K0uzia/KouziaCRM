import { isImapConfigured } from "@/lib/email/imap-config.js";
import { disconnectImapClient, formatConnectionError } from "@/lib/email/sync/imap-connection.js";
import {
  buildMessageListWhere,
  deleteMessage,
  deleteMessages,
  discoverAndEnsureFolders,
  moveMessageToFolder,
  pollFlagChanges,
  syncAllFolders,
  type MessageListFilter,
} from "@/lib/email/sync/folder-sync.js";
import { getMailSyncStatus, updateMailSyncStatus } from "@/lib/email/sync/sync-status.js";
import { MailFolderRole } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

export {
  buildMessageListWhere,
  deleteMessage,
  deleteMessages,
  discoverAndEnsureFolders,
  moveMessageToFolder,
  pollFlagChanges,
  syncAllFolders,
};

export async function runMailSync(): Promise<{
  imported: number;
  updated: number;
  folders: number;
}> {
  if (!(await isImapConfigured())) {
    throw new Error("IMAP non configuré");
  }

  try {
    const result = await syncAllFolders();
    const folders = await prisma.mailFolder.findMany({
      where: { isVirtual: false },
    });
    for (const f of folders) {
      await pollFlagChanges(f.id);
    }
    await updateMailSyncStatus({
      connected: true,
      lastError: null,
      lastSyncAt: new Date(),
      reconnectAt: null,
    });
    return result;
  } catch (err) {
    await updateMailSyncStatus({
      connected: false,
      lastError: formatConnectionError(err),
      reconnectAt: new Date(Date.now() + 60_000),
    });
    await disconnectImapClient();
    throw err;
  }
}

/** Compat legacy imap-sync.ts */
export async function syncImapInbox(): Promise<{ imported: number; skipped: number }> {
  const result = await runMailSync();
  return { imported: result.imported, skipped: result.updated };
}

export async function countMessagesByAudience(
  filter: Omit<MessageListFilter, "audience" | "skip" | "take">,
): Promise<{ all: number; clients: number; external: number }> {
  const [all, clients, external] = await Promise.all([
    prisma.emailMessage.count({ where: buildMessageListWhere({ ...filter }) }),
    prisma.emailMessage.count({ where: buildMessageListWhere({ ...filter, audience: "clients" }) }),
    prisma.emailMessage.count({ where: buildMessageListWhere({ ...filter, audience: "external" }) }),
  ]);
  return { all, clients, external };
}

export async function getMailFoldersWithCounts() {
  const folders = await discoverAndEnsureFolders();
  const inbox = folders.find((f) => f.role === MailFolderRole.INBOX);
  return {
    folders: folders.map((f) => ({
      id: f.id,
      imapPath: f.imapPath,
      displayName: f.displayName,
      role: f.role,
      unreadCount: f.unreadCount,
      isVirtual: f.isVirtual,
    })),
    virtualFolders: [
      { id: "virtual:unread", displayName: "Non lus", role: "CUSTOM", unreadCount: inbox?.unreadCount ?? 0 },
      { id: "virtual:starred", displayName: "Avec étoile", role: "CUSTOM" },
      { id: "virtual:attachments", displayName: "Avec pièces jointes", role: "CUSTOM" },
    ],
    syncStatus: await getMailSyncStatus(),
  };
}

export { getMailSyncStatus };
