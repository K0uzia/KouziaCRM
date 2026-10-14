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
 * Durée maximale d'un passage. Une commande IMAP sans réponse (socket à demi coupée) laissait
 * inFlight en attente pour toujours : IDLE, repli et bouton récupéraient la même promesse et
 * lastSyncAt restait figé jusqu'au redémarrage du worker.
 */
export const SYNC_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Synchronise tous les dossiers. Un seul passage à la fois sur la connexion IMAP partagée :
 * un appel pendant un passage en cours (IDLE, repli, bouton) en redemande un juste après,
 * pour qu'un message arrivé pendant le passage ne soit pas manqué.
 */
export function runMailSync(timeoutMs = SYNC_TIMEOUT_MS): Promise<MailSyncResult> {
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      let result: MailSyncResult;
      do {
        rerun = false;
        result = await withSyncTimeout(syncOnce(), timeoutMs);
      } while (rerun);
      return result;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

class SyncTimeoutError extends Error {}

/** Passage bloqué : la connexion est fermée de force, la synchro suivante repart sur une neuve. */
async function withSyncTimeout(pass: Promise<MailSyncResult>, timeoutMs: number): Promise<MailSyncResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SyncTimeoutError(`Synchronisation bloquée depuis ${Math.round(timeoutMs / 1000)} s : connexion relancée`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([pass, timeout]);
  } catch (err) {
    if (!(err instanceof SyncTimeoutError)) throw err;
    // Le passage abandonné peut encore rejeter plus tard : son erreur est déjà remplacée par celle-ci.
    pass.catch(() => undefined);
    await updateMailSyncStatus({
      connected: false,
      lastError: err.message,
      reconnectAt: new Date(Date.now() + 60_000),
    });
    await disconnectImapClient();
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

/** Ordre d'affichage des dossiers : réception d'abord, dossiers personnels ensuite. */
const FOLDER_ROLE_ORDER: Record<string, number> = {
  INBOX: 0,
  SENT: 1,
  DRAFTS: 2,
  ARCHIVE: 3,
  JUNK: 4,
  TRASH: 5,
  CUSTOM: 6,
};

/**
 * Dossiers servis depuis la base : le worker les redécouvre (LIST IMAP) à chaque passage.
 * L'écran s'ouvre sans attendre le serveur de mail et reste consultable s'il est injoignable ;
 * l'erreur reste visible dans syncStatus. LIST seulement si aucun dossier n'est encore connu.
 */
export async function getMailFoldersWithCounts() {
  const cached = await prisma.mailFolder.findMany({ where: { isVirtual: false } });
  const folders = (cached.length > 0 ? cached : await discoverAndEnsureFolders()).sort(
    (a, b) =>
      (FOLDER_ROLE_ORDER[a.role] ?? 9) - (FOLDER_ROLE_ORDER[b.role] ?? 9) ||
      a.displayName.localeCompare(b.displayName, "fr"),
  );
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
