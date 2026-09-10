import { useEffect, useRef } from "react";
import type { SyncStatus } from "@/pages/messaging/MailLayout";

/**
 * Déclenche un refresh quand lastSyncAt change (nouveau sync IMAP).
 * Ignore le premier passage et les re-renders où le callback change d'identité.
 */
export function useMailNotifications(
  onNewMail: () => void,
  syncStatus: SyncStatus | null,
) {
  const lastSync = useRef<string | null>(null);
  const onNewMailRef = useRef(onNewMail);
  onNewMailRef.current = onNewMail;

  useEffect(() => {
    const at = syncStatus?.lastSyncAt ?? null;
    if (!at) return;
    if (lastSync.current && lastSync.current !== at) {
      onNewMailRef.current();
    }
    lastSync.current = at;
  }, [syncStatus?.lastSyncAt]);
}
