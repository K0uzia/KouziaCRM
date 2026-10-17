import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { isOnline, onReconnect } from "@/lib/network";

// Un aller-retour par relevé : 30 s suffisent pour un badge (retour sur l'onglet : relevé immédiat).
const POLL_MS = 30_000;

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
      // Onglet caché ou hors ligne : relevé en pause, repris au retour (visibilitychange, onReconnect).
      if (document.visibilityState !== "visible" || !isOnline()) return;
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
    const stopReconnect = onReconnect(onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      stopReconnect();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { unreadCount };
}
