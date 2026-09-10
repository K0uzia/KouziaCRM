import { useEffect, useRef } from "react";
import { api } from "@/lib/api";

const DEBOUNCE_MS = 60_000;

/** Sync IMAP au focus fenêtre (debounce long pour éviter le clignotement). */
export function useInboxSync(onSynced?: () => void) {
  const lastSync = useRef(0);
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;

  useEffect(() => {
    function onFocus() {
      if (Date.now() - lastSync.current < DEBOUNCE_MS) return;
      lastSync.current = Date.now();
      void api("/api/emails/sync", { method: "POST" })
        .then(() => onSyncedRef.current?.())
        .catch(() => {});
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}
