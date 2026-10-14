import { useEffect, useRef } from "react";
import { MAIL_SYNC_STATUS_EVENT } from "@/hooks/useNewMailAlert";
import type { SyncStatus } from "@/pages/messaging/MailLayout";

/**
 * Tient l'état de synchro à jour sans action de l'utilisateur et déclenche un refresh quand
 * lastSyncAt change (nouveau passage du worker). L'état vient de la relecture globale
 * (useNewMailAlert) : sans elle, un écran resté ouvert gardait le lastSyncAt de son chargement
 * et affichait « Aucune synchronisation automatique » alors que le worker synchronisait.
 * Ignore le premier passage et les re-renders où le callback change d'identité.
 */
export function useMailNotifications(
  onNewMail: () => void,
  syncStatus: SyncStatus | null,
  setSyncStatus: (status: SyncStatus) => void,
) {
  const lastSync = useRef<string | null>(null);
  const onNewMailRef = useRef(onNewMail);
  onNewMailRef.current = onNewMail;
  const setSyncStatusRef = useRef(setSyncStatus);
  setSyncStatusRef.current = setSyncStatus;

  useEffect(() => {
    const at = syncStatus?.lastSyncAt ?? null;
    if (!at) return;
    if (lastSync.current && lastSync.current !== at) {
      onNewMailRef.current();
    }
    lastSync.current = at;
  }, [syncStatus?.lastSyncAt]);

  useEffect(() => {
    const onStatus = (e: Event) => setSyncStatusRef.current((e as CustomEvent<SyncStatus>).detail);
    window.addEventListener(MAIL_SYNC_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(MAIL_SYNC_STATUS_EVENT, onStatus);
  }, []);
}
