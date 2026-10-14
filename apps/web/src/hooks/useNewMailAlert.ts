import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const POLL_MS = 15_000;

/** Événement diffusé à chaque relecture : la messagerie ouverte y lit l'état de synchro du worker. */
export const MAIL_SYNC_STATUS_EVENT = "kouzia:mail-sync-status";

type SyncStatus = {
  inboxUnreadCount?: number;
  lastSyncAt?: string | null;
};

/**
 * Compteur de messages non lus (badge de la barre latérale). L'annonce des nouveaux
 * messages (toast, son, notification du PC) est faite par le centre de notifications.
 * Seule relecture périodique de /api/emails/sync-status, onglet visible seulement.
 */
export function useNewMailAlert() {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (document.visibilityState !== "visible") return;
      try {
        const status = await api<SyncStatus>("/api/emails/sync-status");
        if (cancelled) return;
        setUnreadCount(Math.max(0, status.inboxUnreadCount ?? 0));
        window.dispatchEvent(new CustomEvent(MAIL_SYNC_STATUS_EVENT, { detail: status }));
      } catch {
        /* réseau ou IMAP non configuré */
      }
    }
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    // Retour sur l'onglet (téléphone déverrouillé, PWA rouverte) : relecture immédiate.
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { unreadCount };
}
