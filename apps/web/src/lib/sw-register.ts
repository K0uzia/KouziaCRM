import { Workbox } from "workbox-window";
import { onReconnect } from "@/lib/network";
import { offlineEnabled } from "@/lib/offline/config";
import { markUpdateWaiting } from "@/lib/version";

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Même fichier partout ; le paramètre active le cache des écrans, seulement sur l'origine du hors ligne. */
export function serviceWorkerUrl(): string {
  return offlineEnabled() ? "/sw.js?mode=hors-ligne" : "/sw.js";
}

/** Avancement d'une mise à jour, pour le toast « Mise à jour en cours… ». */
export type UpdateProgress =
  | { phase: "download"; done: number; total: number | null }
  | { phase: "activate" }
  | { phase: "reload" };

/** Mise à jour impossible ou trop longue : le toast propose « Réessayer ». */
export class UpdateError extends Error {}

/** Installation d'une nouvelle version : 60 s au plus (réseau lent), au-delà une erreur, jamais un rechargement à l'aveugle. */
const INSTALL_TIMEOUT_MS = 60_000;
const ACTIVATE_TIMEOUT_MS = 15_000;

/** Attend qu'un service worker en cours d'installation soit installé ; null s'il est abandonné ; erreur au-delà du délai. */
function installed(worker: ServiceWorker, timeoutMs: number): Promise<ServiceWorker | null> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new UpdateError("installation trop longue")), timeoutMs);
    const done = () => {
      if (worker.state === "installed" || worker.state === "activating" || worker.state === "activated") {
        window.clearTimeout(timer);
        resolve(worker);
      } else if (worker.state === "redundant") {
        window.clearTimeout(timer);
        resolve(null);
      }
    };
    worker.addEventListener("statechange", done);
    done();
  });
}

/**
 * « Recharger » vers la dernière version. Sur l'origine du hors ligne, index.html et les écrans viennent du cache du
 * service worker : la nouvelle version est cherchée, installée (fichiers reçus annoncés par le service worker),
 * activée (SKIP_WAITING) puis la page rechargée. Délai dépassé ou échec : UpdateError, la page n'est pas rechargée
 * sur l'ancienne version. Hors de cette origine (pas de cache), simple rechargement.
 */
export async function reloadToLatest(onProgress: (p: UpdateProgress) => void = () => undefined): Promise<void> {
  const container = "serviceWorker" in navigator ? navigator.serviceWorker : null;
  const reg = await container?.getRegistration().catch(() => undefined);
  if (container && reg?.active && container.controller) {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; done?: number; total?: number | null } | null;
      if (data?.type === "UPDATE_PROGRESS") onProgress({ phase: "download", done: data.done ?? 0, total: data.total ?? null });
    };
    container.addEventListener("message", onMessage);
    try {
      onProgress({ phase: "download", done: 0, total: null });
      await reg.update().catch(() => undefined);
      const waiting = reg.waiting ?? (reg.installing ? await installed(reg.installing, INSTALL_TIMEOUT_MS) : null);
      if (waiting && waiting.state === "installed") {
        onProgress({ phase: "activate" });
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new UpdateError("activation trop longue")), ACTIVATE_TIMEOUT_MS);
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
    } finally {
      container.removeEventListener("message", onMessage);
    }
  }
  onProgress({ phase: "reload" });
  window.location.reload();
}

/** Nouvelle version signalée par le serveur : elle s'installe tout de suite en arrière-plan, « Recharger » est ensuite rapide. */
let preinstalled = false;
export function preinstallLatest(): void {
  if (preinstalled || !("serviceWorker" in navigator)) return;
  preinstalled = true;
  void navigator.serviceWorker
    .getRegistration()
    .then((reg) => reg?.update())
    .catch(() => undefined);
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
