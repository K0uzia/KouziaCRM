import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "@/lib/api";

const POLL_MS = 15_000;

type SyncStatus = {
  lastSyncAt?: string | null;
  inboxUnreadCount?: number;
};

export function useNewMailAlert() {
  const { pathname } = useLocation();
  const [visible, setVisible] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const lastUnread = useRef<number | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (pathname.startsWith("/inbox")) {
      setVisible(false);
    }
  }, [pathname]);

  const poll = useCallback(async () => {
    try {
      const status = await api<SyncStatus>("/api/emails/sync-status");
      const count = Math.max(0, status.inboxUnreadCount ?? 0);
      setUnreadCount(count);

      if (!initialized.current) {
        initialized.current = true;
        lastUnread.current = count;
        return;
      }

      const prev = lastUnread.current ?? 0;
      lastUnread.current = count;

      // Notifier uniquement si le compteur de non-lus augmente (vrai nouveau mail).
      if (count > prev && !pathname.startsWith("/inbox")) {
        setVisible(true);
        if (
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          new Notification("Kouzia - ERP", {
            body:
              count === 1
                ? "1 nouveau message non lu"
                : `${count} messages non lus`,
          });
        }
      }

      // Si tout est lu, masquer la pastille.
      if (count === 0) {
        setVisible(false);
      }
    } catch {
      /* réseau ou IMAP non configuré */
    }
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      await poll();
    }

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [poll]);

  function dismiss() {
    setVisible(false);
  }

  return { visible, unreadCount, dismiss };
}
