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

/** Délai de regroupement des événements IDLE (plusieurs EXISTS d'affilée = une seule synchro). */
const EXISTS_DEBOUNCE_MS = 1500;
/** IDLE relancé régulièrement : les serveurs coupent une session IDLE au bout de 29 min (RFC 2177). */
const IDLE_REFRESH_MS = 25 * 60 * 1000;
/** Délai de réponse au NOOP de rafraîchissement avant de fermer la connexion. */
const IDLE_NOOP_TIMEOUT_MS = 30_000;
/** Filet de sécurité : sans synchro depuis ce délai, le repli synchronise même si IDLE est actif. */
export const FALLBACK_STALE_MS = 2 * 60 * 1000;

const listening = new WeakSet<object>();

function log(message: string, extra?: unknown) {
  if (extra === undefined) console.log(`[mail] ${message}`);
  else console.log(`[mail] ${message}`, extra);
}

/** Synchro déclenchée par un événement, erreurs journalisées (jamais d'exception non gérée). */
async function syncFrom(reason: string): Promise<void> {
  try {
    const result = await runMailSync();
    log(`synchro (${reason}) : ${result.imported} importé(s), ${result.updated} mis à jour`);
  } catch (err) {
    console.error(`[mail] synchro (${reason}) en échec`, formatConnectionError(err));
  }
}

export function stopIdleWorker(): void {
  idleAbort?.abort();
  idleRunning = false;
}

/**
 * IDLE IMAP sur la boîte de réception. Un nouveau message (événement EXISTS) ne met PAS fin à
 * IDLE : imapflow émet seulement « exists ». On l'écoute pour synchroniser aussitôt ; sans cela,
 * les messages n'arrivaient qu'au rafraîchissement d'IDLE ou au clic sur « Synchroniser ».
 */
export async function startIdleWorker(): Promise<void> {
  if (idleRunning) return;
  if (!(await isImapConfigured())) {
    log("IDLE non démarré : IMAP non configuré");
    return;
  }

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
          // Premier démarrage : la synchro découvre les dossiers, IDLE démarre au tour suivant.
          await syncFrom("découverte des dossiers");
          await sleep(60_000);
          continue;
        }

        const { client } = await getImapClient();
        if (!listening.has(client)) {
          listening.add(client);
          let timer: ReturnType<typeof setTimeout> | undefined;
          client.on("exists", (data: { path?: string; count?: number; prevCount?: number }) => {
            log(`IDLE : nouveau message sur ${data.path ?? "?"} (${data.prevCount ?? "?"} -> ${data.count ?? "?"})`);
            clearTimeout(timer);
            timer = setTimeout(() => void syncFrom("IDLE"), EXISTS_DEBOUNCE_MS);
          });
        }
        await client.mailboxOpen(inbox.imapPath);
        await updateMailSyncStatus({ idleActive: true, connected: true, lastError: null });
        log(`IDLE actif sur ${inbox.imapPath}`);

        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const refresh = setTimeout(() => {
          // Toute commande met fin à IDLE : la boucle synchronise puis relance IDLE.
          void client.noop().catch(() => {});
          // Pas de réponse au NOOP : socket à demi coupée, fermeture forcée puis reconnexion.
          watchdog = setTimeout(() => client.close(), IDLE_NOOP_TIMEOUT_MS);
        }, IDLE_REFRESH_MS);
        let onClose: (() => void) | undefined;

        try {
          await Promise.race([
            client.idle(),
            new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }),
            // Connexion coupée pendant IDLE (serveur, réseau) : reconnexion avec backoff.
            new Promise<never>((_, reject) => {
              onClose = () => reject(new Error("Connexion IMAP fermée pendant IDLE"));
              client.once("close", onClose);
            }),
          ]);
        } finally {
          clearTimeout(refresh);
          clearTimeout(watchdog);
          if (onClose) client.off("close", onClose);
        }
        if (!signal.aborted) await syncFrom("fin d'IDLE");
        backoffMs = 1000;
      } catch (err) {
        console.error("[mail] IDLE interrompu", formatConnectionError(err));
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

/**
 * Repli (cron, chaque minute). IDLE inactif : synchro. IDLE actif : synchro seulement si la
 * dernière date de plus de FALLBACK_STALE_MS (IDLE muet, connexion à demi coupée).
 */
export async function runMailPollFallback(now = Date.now()): Promise<"synced" | "skipped"> {
  if (!(await isImapConfigured())) return "skipped";
  const status = await prisma.mailSyncStatus.findUnique({ where: { id: "default" } });
  const age = status?.lastSyncAt ? now - status.lastSyncAt.getTime() : Infinity;
  if (status?.idleActive && age < FALLBACK_STALE_MS) return "skipped";
  await syncFrom(
    status?.idleActive
      ? `repli, IDLE muet depuis ${Math.round(age / 60_000)} min`
      : "repli, IDLE inactif",
  );
  return "synced";
}
