import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const POLL_MS = 15_000;

type SyncStatus = {
  inboxUnreadCount?: number;
};

/**
 * Compteur de messages non lus (badge de la barre latérale). L'annonce des nouveaux
 * messages (toast, son, notification du PC) est faite par le centre de notifications.
 */
export function useNewMailAlert() {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const status = await api<SyncStatus>("/api/emails/sync-status");
        if (!cancelled) setUnreadCount(Math.max(0, status.inboxUnreadCount ?? 0));
      } catch {
        /* réseau ou IMAP non configuré */
      }
    }
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { unreadCount };
}
