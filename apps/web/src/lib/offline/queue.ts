import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api";
import { isOfflineError, isOnline } from "../network";
import { offlineEnabled } from "./config";
import { deleteSealed, putSealed, readAllSealed } from "./store";

/**
 * File des créations préparées hors ligne (lot 3) : un client, un devis en brouillon, une note de rendez-vous.
 * - Chaque élément porte un UUID (clientRequestId, envoyé à l'API : un renvoi rend l'élément déjà créé) et sa
 *   date de préparation. Il est chiffré dans IndexedDB comme la copie (magasin « file »), sans cookie ni jeton.
 * - Envoi rejoué depuis la page (retour du réseau, puis session vérifiée), jamais par Background Sync : rien ne
 *   part sans l'utilisateur connecté devant l'ERP.
 * - Dépendances dans l'ordre : un devis ou une note pour un client préparé hors ligne (identifiant « local-… »)
 *   attend que ce client soit créé, puis prend son vrai identifiant.
 * - Écarts (client modifié, prix changé, adresse déjà connue) : l'élément est créé, l'écart est gardé à relire
 *   (magasin « relire ») ; client supprimé ou donnée refusée : l'élément reste dans la file, « à revoir ».
 */
export type QueueKind = "client" | "quote" | "note";
/** waiting : à envoyer ; error : envoi échoué (serveur), nouvel essai automatique ; review : à revoir. */
export type QueueState = "waiting" | "error" | "review";

export type QueueItem = {
  /** clientRequestId (UUID). */
  id: string;
  kind: QueueKind;
  /** Ordre de préparation : l'envoi suit cet ordre. */
  seq: number;
  preparedAt: string;
  state: QueueState;
  message: string | null;
  /** Libellé affiché (« Devis pour Lou Martin, 1 200,00 € »). */
  label: string;
  /** Client concerné : vrai identifiant, ou « local-<uuid> » d'un client de la file (pour un client : le sien). */
  clientId: string;
  clientName: string;
  /** Corps de la requête, sans clientRequestId ni clientId. */
  body: Record<string, unknown>;
};

export type ReviewSignal = {
  id: string;
  kind: QueueKind;
  label: string;
  /** Écran où relire l'élément créé. */
  to: string;
  targetId: string;
  messages: string[];
  at: string;
};

export type QueueSnapshot = {
  ready: boolean;
  items: QueueItem[];
  signals: ReviewSignal[];
  /** Session refusée par le serveur au dernier essai : reconnexion nécessaire avant l'envoi. */
  sessionExpired: boolean;
  sending: boolean;
};

export type ReplayStatus = "idle" | "done" | "offline" | "session" | "error";

const LOCAL_PREFIX = "local-";
export const localClientId = (requestId: string) => `${LOCAL_PREFIX}${requestId}`;
export const isLocalClientId = (id: string | undefined | null): id is string => Boolean(id?.startsWith(LOCAL_PREFIX));

let snapshot: QueueSnapshot = { ready: false, items: [], signals: [], sessionExpired: false, sending: false };
const listeners = new Set<() => void>();
/** Clients de la file déjà créés pendant cette session : « local-… » vers le vrai identifiant. */
const resolved = new Map<string, string>();
let loading: Promise<void> | null = null;
let running: Promise<ReplayStatus> | null = null;
let seqBase = 0;

const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("kouzia-file");
channel?.addEventListener("message", () => void reload());

function set(next: Partial<QueueSnapshot>, broadcast = false) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
  if (broadcast) channel?.postMessage("change");
}

const bySeq = (a: QueueItem, b: QueueItem) => a.seq - b.seq;

async function reload(): Promise<void> {
  if (!offlineEnabled()) {
    set({ ready: true });
    return;
  }
  const [items, signals] = await Promise.all([
    readAllSealed<QueueItem>("file").catch(() => [] as QueueItem[]),
    readAllSealed<ReviewSignal>("relire").catch(() => [] as ReviewSignal[]),
  ]);
  set({ ready: true, items: items.sort(bySeq), signals: signals.sort((a, b) => b.at.localeCompare(a.at)) });
}

export function loadQueue(): Promise<void> {
  loading ??= reload();
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getQueueSnapshot(): QueueSnapshot {
  return snapshot;
}

/** État de la file (éléments, écarts à relire, session), chargé à la première lecture. */
export function useOfflineQueue(): QueueSnapshot {
  useEffect(() => {
    void loadQueue();
  }, []);
  return useSyncExternalStore(subscribe, getQueueSnapshot, getQueueSnapshot);
}

async function save(item: QueueItem): Promise<void> {
  await putSealed("file", item.id, item);
  set({ items: [...snapshot.items.filter((i) => i.id !== item.id), item].sort(bySeq) }, true);
}

async function drop(id: string): Promise<void> {
  await deleteSealed("file", id);
  set({ items: snapshot.items.filter((i) => i.id !== id) }, true);
}

async function addSignal(signal: ReviewSignal): Promise<void> {
  await putSealed("relire", signal.id, signal);
  set({ signals: [signal, ...snapshot.signals.filter((s) => s.id !== signal.id)] }, true);
}

export async function dismissSignal(id: string): Promise<void> {
  await deleteSealed("relire", id);
  set({ signals: snapshot.signals.filter((s) => s.id !== id) }, true);
}

/** Écart à relire sur un élément créé (badge « Préparé hors ligne, à relire » de la fiche). */
export function signalFor(targetId: string): ReviewSignal | null {
  return snapshot.signals.find((s) => s.targetId === targetId) ?? null;
}

export function resolvedClientId(localId: string): string | null {
  return resolved.get(localId) ?? null;
}

const PATHS: Record<QueueKind, (item: QueueItem) => string> = {
  client: () => "/api/clients",
  quote: () => "/api/invoices",
  note: (item) => `/api/clients/${encodeURIComponent(item.clientId)}/notes`,
};

function requestBody(item: QueueItem): Record<string, unknown> {
  if (item.kind === "client") return { ...item.body, clientRequestId: item.id };
  if (item.kind === "quote") return { ...item.body, clientId: item.clientId, clientRequestId: item.id };
  return { ...item.body, clientRequestId: item.id, preparedAt: item.preparedAt };
}

function send<T>(item: QueueItem): Promise<T> {
  return api<T>(PATHS[item.kind](item), { method: "POST", body: JSON.stringify(requestBody(item)) });
}

export type PrepareInput = {
  kind: QueueKind;
  label: string;
  clientId?: string;
  clientName: string;
  body: Record<string, unknown>;
};

/** Élément préparé, pas encore envoyé (hors ligne, ou client lui-même encore dans la file). */
export async function enqueue(input: PrepareInput, id: string = crypto.randomUUID()): Promise<QueueItem> {
  await loadQueue();
  const now = Date.now();
  seqBase = Math.max(seqBase + 1, now, ...snapshot.items.map((i) => i.seq + 1));
  const item: QueueItem = {
    id,
    kind: input.kind,
    seq: seqBase,
    preparedAt: new Date(now).toISOString(),
    state: "waiting",
    message: null,
    label: input.label,
    clientId: input.kind === "client" ? localClientId(id) : input.clientId!,
    clientName: input.clientName,
    body: input.body,
  };
  await save(item);
  return item;
}

export type Submitted<T> = { queued: true; item: QueueItem } | { queued: false; data: T };

/**
 * Création depuis un formulaire, sur l'origine du hors ligne : envoi direct avec un clientRequestId, ou mise en
 * file hors ligne (ou serveur injoignable, même UUID : un envoi parti malgré tout ne sera pas doublé).
 */
export async function submitCreation<T>(input: PrepareInput): Promise<Submitted<T>> {
  const id = crypto.randomUUID();
  const queue = async (): Promise<Submitted<T>> => ({ queued: true, item: await enqueue(input, id) });
  if (!isOnline() || isLocalClientId(input.clientId)) {
    const result = await queue();
    if (isOnline()) void replayQueue();
    return result;
  }
  const draft: QueueItem = {
    id,
    kind: input.kind,
    seq: 0,
    preparedAt: new Date().toISOString(),
    state: "waiting",
    message: null,
    label: input.label,
    clientId: input.clientId ?? "",
    clientName: input.clientName,
    body: input.body,
  };
  try {
    return { queued: false, data: await send<T>(draft) };
  } catch (error) {
    if (isOfflineError(error)) return queue();
    throw error;
  }
}

/** Nouvel essai d'un élément « à revoir » ou en erreur. */
export async function retryItem(id: string, onSessionExpired?: () => void): Promise<ReplayStatus> {
  const item = snapshot.items.find((i) => i.id === id);
  if (item) await save({ ...item, state: "waiting", message: null });
  return replayQueue({ onSessionExpired });
}

/** Suppression d'un élément ; ce qui dépendait d'un client retiré passe « à revoir ». */
export async function removeItem(id: string): Promise<void> {
  const item = snapshot.items.find((i) => i.id === id);
  await drop(id);
  if (item?.kind !== "client") return;
  for (const child of snapshot.items.filter((i) => i.clientId === item.clientId)) {
    await save({ ...child, state: "review", message: "Le client préparé hors ligne a été retiré de la file." });
  }
}

/** Éléments qui attendent ce client de la file. */
export function dependentsOf(item: QueueItem): QueueItem[] {
  return item.kind === "client" ? snapshot.items.filter((i) => i.kind !== "client" && i.clientId === item.clientId) : [];
}

type ApiFailure = Error & { status?: number; code?: string; data?: { client?: { id: string; displayName: string } } };

async function attach(localId: string, realId: string, realName: string | null) {
  resolved.set(localId, realId);
  for (const child of snapshot.items.filter((i) => i.clientId === localId)) {
    await save({ ...child, clientId: realId, clientName: realName ?? child.clientName });
  }
}

async function sendOne(item: QueueItem): Promise<"sent" | "review" | "session" | "offline" | "error"> {
  try {
    if (item.kind === "client") {
      const client = await send<{ id: string; displayName: string }>(item);
      await attach(item.clientId, client.id, client.displayName);
    } else if (item.kind === "quote") {
      const quote = await send<{ id: string; offline?: { conflicts: Array<{ message: string }> } }>(item);
      const conflicts = quote.offline?.conflicts ?? [];
      if (conflicts.length) {
        await addSignal({
          id: item.id,
          kind: "quote",
          label: item.label,
          to: `/quotes/${quote.id}`,
          targetId: quote.id,
          messages: conflicts.map((c) => c.message),
          at: new Date().toISOString(),
        });
      }
    } else {
      await send(item);
    }
    await drop(item.id);
    return "sent";
  } catch (raw) {
    const error = raw as ApiFailure;
    if (isOfflineError(error)) return "offline";
    if (error.status === 401) return "session";
    const existing = error.data?.client;
    if (item.kind === "client" && error.status === 409 && error.code === "client_exists" && existing) {
      // Adresse déjà connue : pas de doublon, devis et notes rattachés à la fiche existante, et signalés.
      const children = dependentsOf(item).length;
      await attach(item.clientId, existing.id, existing.displayName);
      await addSignal({
        id: item.id,
        kind: "client",
        label: item.label,
        to: `/clients/${existing.id}`,
        targetId: existing.id,
        messages: [
          `Adresse e-mail déjà connue : fiche existante « ${existing.displayName} » gardée, aucun doublon créé.${
            children ? ` ${children} élément${children > 1 ? "s" : ""} rattaché${children > 1 ? "s" : ""} à cette fiche.` : ""
          }`,
        ],
        at: new Date().toISOString(),
      });
      await drop(item.id);
      return "sent";
    }
    if (error.status === 404 && error.code === "client_not_found") {
      await save({ ...item, state: "review", message: "Client supprimé depuis la préparation." });
      return "review";
    }
    if (error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 429) {
      await save({ ...item, state: "review", message: error.message || "Données refusées par le serveur." });
      return "review";
    }
    await save({ ...item, state: "error", message: error.message || "Envoi impossible pour le moment." });
    return "error";
  }
}

/**
 * Envoi de la file, dans l'ordre de préparation. Appelé par la page (retour du réseau, ouverture de l'ERP,
 * nouvel essai) : session vérifiée d'abord ; refusée, rien ne part et l'écran demande de se reconnecter.
 */
export function replayQueue(opts: { onSessionExpired?: () => void } = {}): Promise<ReplayStatus> {
  running ??= (async (): Promise<ReplayStatus> => {
    await loadQueue();
    if (!snapshot.items.some((i) => i.state !== "review")) return "idle";
    try {
      const me = await api<{ user: unknown }>("/api/auth/me");
      if (!me.user) {
        set({ sessionExpired: true });
        opts.onSessionExpired?.();
        return "session";
      }
    } catch (error) {
      return isOfflineError(error) ? "offline" : "error";
    }
    set({ sessionExpired: false, sending: true });
    try {
      const tried = new Set<string>();
      for (;;) {
        const next = snapshot.items.find((i) => {
          if (i.state === "review" || tried.has(i.id)) return false;
          if (!isLocalClientId(i.clientId) || i.kind === "client") return true;
          // Dépendance : le client de la file passe d'abord ; s'il n'y est plus, l'élément est à revoir.
          return !snapshot.items.some((c) => c.kind === "client" && c.clientId === i.clientId);
        });
        if (!next) return "done";
        tried.add(next.id);
        if (next.kind !== "client" && isLocalClientId(next.clientId)) {
          await save({ ...next, state: "review", message: "Le client préparé hors ligne n'est plus dans la file." });
          continue;
        }
        const outcome = await sendOne(next);
        if (outcome === "session") {
          set({ sessionExpired: true });
          opts.onSessionExpired?.();
          return "session";
        }
        if (outcome === "offline") return "offline";
        if (outcome === "error") return "error";
      }
    } finally {
      set({ sending: false });
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

/** « 1 élément », « 3 éléments ». */
export function itemsLabel(n: number): string {
  return `${n} élément${n > 1 ? "s" : ""}`;
}

/** Tests : état vide, rechargé depuis IndexedDB au prochain accès. */
export function resetQueueForTests(): void {
  loading = null;
  running = null;
  resolved.clear();
  seqBase = 0;
  snapshot = { ready: false, items: [], signals: [], sessionExpired: false, sending: false };
}
