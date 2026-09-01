import { isImapConfigured } from "@/lib/email/imap-config.js";
import {
  disconnectImapClient,
  formatConnectionError,
  getImapClient,
  sleep,
} from "@/lib/email/sync/imap-connection.js";
import { runMailSync } from "@/lib/email/sync/index.js";
import { updateMailSyncStatus } from "@/lib/email/sync/sync-status.js";
import { MailFolderRole } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

let idleRunning = false;
let idleAbort: AbortController | null = null;

export function stopIdleWorker(): void {
  idleAbort?.abort();
  idleRunning = false;
}

export async function startIdleWorker(): Promise<void> {
  if (idleRunning) return;
  if (!(await isImapConfigured())) return;

  idleRunning = true;
  idleAbort = new AbortController();
  const signal = idleAbort.signal;

  void (async () => {
    let backoffMs = 1000;
    while (!signal.aborted && idleRunning) {
      try {
        const inbox = await prisma.mailFolder.findFirst({
          where: { role: MailFolderRole.INBOX, isVirtual: false },
        });
        if (!inbox) {
          await runMailSync();
          await sleep(60_000);
          continue;
        }

        const { client } = await getImapClient();
        await client.mailboxOpen(inbox.imapPath);
        await updateMailSyncStatus({ idleActive: true, connected: true, lastError: null });

        const idleResult = client.idle();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const idlePromise = idleResult.then(async () => {
          if (signal.aborted) return;
          await runMailSync();
        });

        idleTimer = setTimeout(() => {
          client.idleDone?.();
        }, 28 * 60 * 1000);

        await Promise.race([
          idlePromise,
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);

        if (idleTimer) clearTimeout(idleTimer);
        backoffMs = 1000;
      } catch (err) {
        await updateMailSyncStatus({
          idleActive: false,
          connected: false,
          lastError: formatConnectionError(err),
          reconnectAt: new Date(Date.now() + backoffMs),
        });
        await disconnectImapClient();
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 300_000);
      }
    }

    await updateMailSyncStatus({ idleActive: false });
    await disconnectImapClient();
  })();
}

/** Fallback poll toutes les 60 s si IDLE indisponible */
export async function runMailPollFallback(): Promise<void> {
  if (!(await isImapConfigured())) return;
  try {
    await runMailSync();
  } catch (err) {
    console.error("[mail] poll fallback error", formatConnectionError(err));
  }
}
