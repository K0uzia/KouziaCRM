import { toast } from "sonner";
import { Workbox } from "workbox-window";
import { onReconnect } from "@/lib/network";
import { offlineEnabled } from "@/lib/offline/config";

const UPDATE_TOAST_ID = "nouvelle-version";
const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Même fichier partout ; le paramètre active le cache des écrans, seulement sur l'origine du hors ligne. */
export function serviceWorkerUrl(): string {
  return offlineEnabled() ? "/sw.js?mode=hors-ligne" : "/sw.js";
}

/**
 * Origine du hors ligne : service worker enregistré dès le démarrage (écrans en cache) et stockage persistant
 * demandé. Nouvelle version : elle attend, un toast propose « Recharger » ; jamais de rechargement forcé.
 * Ailleurs, le service worker n'est enregistré que pour les notifications push (lib/push.ts).
 */
export function startOfflineShell(): void {
  if (!offlineEnabled() || !("serviceWorker" in navigator)) return;
  void navigator.storage?.persist?.().catch(() => false);
  const wb = new Workbox(serviceWorkerUrl(), { scope: "/" });
  wb.addEventListener("waiting", () => {
    toast("Nouvelle version de l'ERP disponible", {
      id: UPDATE_TOAST_ID,
      description: "Rechargez quand vous voulez : ce qui est enregistré n'est pas perdu.",
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: "Recharger",
        onClick: () => {
          wb.addEventListener("controlling", () => window.location.reload());
          wb.messageSkipWaiting();
        },
      },
    });
  });
  void wb.register().catch(() => undefined);
  const check = () => void wb.update().catch(() => undefined);
  window.setInterval(check, UPDATE_CHECK_MS);
  onReconnect(check);
}
