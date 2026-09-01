import { useEffect, useRef } from "react";
import type { SyncStatus } from "@/pages/messaging/MailLayout";

export function useMailNotifications(
  onNewMail: () => void,
  syncStatus: SyncStatus | null,
) {
  const lastSync = useRef<string | null>(null);

  useEffect(() => {
    if (!syncStatus?.lastSyncAt) return;
    if (lastSync.current && lastSync.current !== syncStatus.lastSyncAt) {
      onNewMail();
    }
    lastSync.current = syncStatus.lastSyncAt;
  }, [syncStatus?.lastSyncAt, onNewMail]);
}
