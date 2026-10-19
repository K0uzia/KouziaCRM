import { Workbox } from "workbox-window";
import { onReconnect } from "@/lib/network";
import { offlineEnabled } from "@/lib/offline/config";
import { markUpdateWaiting } from "@/lib/version";

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Même fichier partout ; le paramètre active le cache des écrans, seulement sur l'origine du hors ligne. */
export function serviceWorkerUrl(): string {
  return offlineEnabled() ? "/sw.js?mode=hors-ligne" : "/sw.js";
}

/** Attend qu'un service worker en cours d'installation soit installé (ou abandonné), 10 s au plus. */
function installed(worker: ServiceWorker): Promise<ServiceWorker | null> {
  return new Promise((resolve) => {
    const done = () => {
      if (worker.state === "installed" || worker.state === "activated") resolve(worker);
      else if (worker.state === "redundant") resolve(null);
    };
    const timer = window.setTimeout(() => resolve(null), 10_000);
    worker.addEventListener("statechange", () => {
      done();
      if (worker.state !== "installing") window.clearTimeout(timer);
    });
    done();
  });
}

/**
 * « Recharger » vers la dernière version. Sur l'origine du hors ligne, index.html et les écrans viennent du cache du
 * service worker : un simple rechargement resservirait l'ancienne version tant que la nouvelle attend. La nouvelle
 * est donc cherchée, activée (SKIP_WAITING) et attendue (controllerchange, 5 s au plus) avant de recharger.
 */
export async function reloadToLatest(): Promise<void> {
  const container = "serviceWorker" in navigator ? navigator.serviceWorker : null;
  const reg = await container?.getRegistration().catch(() => undefined);
  if (container && reg?.active && container.controller) {
    await reg.update().catch(() => undefined);
    const waiting = reg.waiting ?? (reg.installing ? await installed(reg.installing) : null);
    if (waiting && waiting.state === "installed") {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 5000);
        container.addEventListener(
          "controllerchange",
          () => {
            window.clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        waiting.postMessage({ type: "SKIP_WAITING" });
      });
    }
  }
  window.location.reload();
}

/**
 * Origine du hors ligne : service worker enregistré dès le démarrage (écrans en cache) et stockage persistant
 * demandé. Nouvelle version : elle attend ; le bandeau « nouvelle version » (VersionNotice, seul message de mise à
 * jour) propose « Recharger », qui l'active (reloadToLatest) ; jamais de rechargement forcé.
 * Ailleurs, le service worker n'est enregistré que pour les notifications push (lib/push.ts).
 */
export function startOfflineShell(): void {
  if (!offlineEnabled() || !("serviceWorker" in navigator)) return;
  void navigator.storage?.persist?.().catch(() => false);
  const wb = new Workbox(serviceWorkerUrl(), { scope: "/" });
  wb.addEventListener("waiting", () => markUpdateWaiting());
  void wb.register().catch(() => undefined);
  const check = () => void wb.update().catch(() => undefined);
  window.setInterval(check, UPDATE_CHECK_MS);
  onReconnect(check);
}
