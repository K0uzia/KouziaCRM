import { useEffect, useRef } from "react";
import { api } from "@/lib/api";

const DEBOUNCE_MS = 30_000;

export function useInboxSync(onSynced?: () => void) {
  const lastSync = useRef(0);

  useEffect(() => {
    function onFocus() {
      if (Date.now() - lastSync.current < DEBOUNCE_MS) return;
      lastSync.current = Date.now();
      void api("/api/emails/sync", { method: "POST" })
        .then(() => onSynced?.())
        .catch(() => {});
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [onSynced]);
}
