// Imports relatifs uniquement : module testé par vitest sans l'alias « @ ».
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { onReconnect, serverReachable } from "./network";

/**
 * Retour du réseau : 1) serveur joignable, 2) file des créations envoyée, 3) page affichée rechargée (remontée de
 * l'écran, sans rechargement complet), dès que rien n'est en cours de saisie, 4) copie hors ligne mise à jour, puis
 * un seul toast « De nouveau en ligne, données à jour ». La file passe avant la page : ce qui a été préparé hors
 * ligne apparaît dans l'écran rechargé.
 */
export type ReconnectPhase = "idle" | "refreshing";
export type ReconnectSteps = {
  replay: () => Promise<unknown>;
  /** Rend la main une fois le nouvel écran affiché (ses lectures faites). */
  remountPage: () => void | Promise<void>;
  copy: () => Promise<unknown>;
};

let phase: ReconnectPhase = "idle";
const listeners = new Set<() => void>();

function setPhase(next: ReconnectPhase): void {
  phase = next;
  for (const l of listeners) l();
}

export function useReconnectPhase(): ReconnectPhase {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => phase,
    () => "idle" as ReconnectPhase,
  );
}

/** Saisie en cours : fenêtre modale ouverte, ou champ de l'écran qui a le focus. La page attend pour se recharger. */
export function isUserBusy(doc: Document = document): boolean {
  if (doc.querySelector('[data-modal-panel], [role="dialog"][aria-modal="true"]')) return true;
  const el = doc.activeElement as HTMLElement | null;
  if (!el || el === doc.body) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Attend la fin de la saisie (vérifié toutes les demi-secondes) ; abandonne si le réseau retombe. */
async function whenIdle(busy: () => boolean, online: () => boolean): Promise<boolean> {
  while (busy()) {
    if (!online()) return false;
    await wait(500);
  }
  return online();
}

export async function refreshAfterReconnect(
  steps: ReconnectSteps,
  env: { reachable?: () => Promise<boolean>; busy?: () => boolean; online?: () => boolean; tries?: number; pauseMs?: number } = {},
): Promise<"done" | "unreachable" | "offline" | "skipped"> {
  if (phase === "refreshing") return "skipped";
  const reachable = env.reachable ?? (() => serverReachable());
  const busy = env.busy ?? (() => isUserBusy());
  const online = env.online ?? (() => typeof navigator === "undefined" || navigator.onLine);
  setPhase("refreshing");
  try {
    let ok = false;
    for (let i = 0; i < (env.tries ?? 3) && !ok; i++) {
      ok = await reachable();
      if (!ok) await wait(env.pauseMs ?? 2000);
    }
    if (!ok) return "unreachable";
    await steps.replay();
    if (!(await whenIdle(busy, online))) return "offline";
    await steps.remountPage();
    await steps.copy();
    toast.success("De nouveau en ligne, données à jour", { id: "de-nouveau-en-ligne", duration: 3000 });
    return "done";
  } finally {
    setPhase("idle");
  }
}

/** Écoute le retour du réseau (événement « online ») ; rend la fonction d'arrêt. */
export function startReconnectRefresh(steps: ReconnectSteps): () => void {
  return onReconnect(() => void refreshAfterReconnect(steps));
}
