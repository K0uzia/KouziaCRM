import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "@/lib/api";

const POLL_MS = 30_000;

type SyncStatus = {
  lastSyncAt?: string | null;
};

export function useNewMailAlert() {
  const { pathname } = useLocation();
  const [visible, setVisible] = useState(false);
  const lastSyncAt = useRef<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (pathname.startsWith("/inbox")) {
      setVisible(false);
    }
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const status = await api<SyncStatus>("/api/emails/sync-status");
        if (cancelled || !status.lastSyncAt) return;

        if (initialized.current && lastSyncAt.current !== status.lastSyncAt) {
          if (!pathname.startsWith("/inbox")) {
            setVisible(true);
            if (
              typeof Notification !== "undefined" &&
              Notification.permission === "granted"
            ) {
              new Notification("KouziaCRM", { body: "Nouveaux messages reçus" });
            }
          }
        }

        initialized.current = true;
        lastSyncAt.current = status.lastSyncAt;
      } catch {
        /* réseau ou IMAP non configuré */
      }
    }

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pathname]);

  function dismiss() {
    setVisible(false);
  }

  return { visible, dismiss };
}
