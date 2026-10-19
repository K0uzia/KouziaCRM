import { useSyncExternalStore } from "react";
import { API_CONTRACT, BUILD_HEADER, CONTRACT_HEADER } from "@kouzia-erp/api-contract";

/** Identifiant du build de cette interface (vite.config.ts) ; « dev » hors build de production. */
declare const __KOUZIA_BUILD__: string;
const OWN_BUILD = typeof __KOUZIA_BUILD__ === "string" ? __KOUZIA_BUILD__ : "dev";

/**
 * Interface plus ancienne que le serveur : « build » (nouvelle version, recharger quand on veut) ou « contract » (le
 * format de l'API a changé : rechargement obligatoire). Prévient les autres onglets par BroadcastChannel.
 */
export type VersionState = "ok" | "build" | "contract";
let state: VersionState = "ok";
const listeners = new Set<() => void>();
const CHANNEL = "kouzia-version";
let channel: BroadcastChannel | null = null;

function setState(next: VersionState, broadcast: boolean): void {
  // Un écart de contrat l'emporte sur un simple nouveau build ; jamais de retour à « ok » sans rechargement.
  if (next === "ok" || (state === "contract" && next === "build") || state === next) return;
  state = next;
  for (const listener of listeners) listener();
  if (broadcast) channel?.postMessage(next);
}

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(CHANNEL);
  // Node (tests) : un canal ouvert garderait le processus en vie.
  (channel as { unref?: () => void }).unref?.();
  channel.onmessage = (event: MessageEvent) => {
    if (event.data === "build" || event.data === "contract") setState(event.data, false);
  };
}

/** Lit les en-têtes d'une réponse /api et signale un écart de version (une fois par état). */
export function checkVersionHeaders(headers: Headers): void {
  const contract = headers.get(CONTRACT_HEADER);
  const build = headers.get(BUILD_HEADER);
  ensureChannel();
  if (contract !== null && Number(contract) !== API_CONTRACT) setState("contract", true);
  else if (build && OWN_BUILD !== "dev" && build !== OWN_BUILD) setState("build", true);
}

/** Nouvelle version installée par le service worker et en attente : même bandeau qu'un nouveau build côté serveur. */
export function markUpdateWaiting(): void {
  ensureChannel();
  setState("build", true);
}

export function useVersionState(): VersionState {
  ensureChannel();
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
    () => "ok",
  );
}

/** Tests : état neuf. */
export function resetVersionForTests(): void {
  state = "ok";
}
