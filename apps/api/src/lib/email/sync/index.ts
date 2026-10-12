import { isImapConfigured } from "@/lib/email/imap-config.js";
import { disconnectImapClient, formatConnectionError } from "@/lib/email/sync/imap-connection.js";
import {
  buildMessageListWhere,
  deleteMessage,
  deleteMessages,
  discoverAndEnsureFolders,
  emptyTrashFolder,
  moveMessageToFolder,
  pollFlagChanges,
  syncAllFolders,
  type MessageListFilter,
} from "@/lib/email/sync/folder-sync.js";
import { getMailSyncStatus, updateMailSyncStatus } from "@/lib/email/sync/sync-status.js";
import { prisma } from "@/lib/prisma.js";

export {
  buildMessageListWhere,
  deleteMessage,
  deleteMessages,
  discoverAndEnsureFolders,
  emptyTrashFolder,
  moveMessageToFolder,
  pollFlagChanges,
  syncAllFolders,
};

type MailSyncResult = { imported: number; updated: number; folders: number };

let inFlight: Promise<MailSyncResult> | null = null;
let rerun = false;

/**
 * Synchronise tous les dossiers. Un seul passage à la fois sur la connexion IMAP partagée :
 * un appel pendant un passage en cours (IDLE, repli, bouton) en redemande un juste après,
 * pour qu'un message arrivé pendant le passage ne soit pas manqué.
 */
export function runMailSync(): Promise<MailSyncResult> {
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      let result: MailSyncResult;
      do {
        rerun = false;
        result = await syncOnce();
      } while (rerun);
      return result;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function syncOnce(): Promise<MailSyncResult> {
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
  // Boîte injoignable (panne, identifiants changés) : les dossiers et messages déjà synchronisés
  // restent consultables ; l'erreur reste visible dans syncStatus.
  const folders = await discoverAndEnsureFolders().catch(async (err: unknown) => {
    const cached = await prisma.mailFolder.findMany({ where: { isVirtual: false }, orderBy: { displayName: "asc" } });
    if (cached.length === 0) throw err;
    return cached;
  });
  return {
    folders: folders.map((f) => ({
      id: f.id,
      imapPath: f.imapPath,
      displayName: f.displayName,
      role: f.role,
      unreadCount: f.unreadCount,
      isVirtual: f.isVirtual,
    })),
    /** Conservé pour compat clients anciens ; les filtres sont désormais côté liste. */
    virtualFolders: [] as Array<{
      id: string;
      displayName: string;
      role: string;
      unreadCount?: number;
    }>,
    syncStatus: await getMailSyncStatus(),
  };
}

export { getMailSyncStatus };
