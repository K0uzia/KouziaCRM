import { OfflineError } from "./network";
import { offlineEnabled } from "./offline/config";
import { copyServes, offlineRule } from "./offline/rules";
import { markFresh, markServedFromCopy, tagCopy } from "./offline/served";
import { readCopy, saveCopy } from "./offline/store";

/** Écriture réussie dans l'espace Site : la barre de publication recompte les changements. */
export const SITE_CHANGED_EVENT = "kouzia:site-changed";

/** Serveur injoignable derrière le tunnel (passerelle Cloudflare, 502 à 530) : la copie locale peut servir. */
const SERVER_DOWN = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);

export type ApiInit = RequestInit & {
  /** « blob » : fichier (PDF, CSV) au lieu de JSON. */
  responseType?: "json" | "blob";
};

export async function api<T>(path: string, options?: ApiInit): Promise<T> {
  const { responseType = "json", ...init } = options ?? {};
  const method = (init.method ?? "GET").toUpperCase();
  // Lecture de la liste fermée (lib/offline/rules), sur l'origine autorisée : réseau d'abord, copie ensuite.
  const rule = method === "GET" && responseType === "json" && offlineEnabled() ? offlineRule(path) : null;
  const route = typeof window === "undefined" ? "" : window.location.pathname;
  const fromCopy = async (): Promise<{ data: T } | null> => {
    if (!rule || !copyServes(rule, route)) return null;
    const copy = await readCopy<T>(path).catch(() => null);
    if (!copy) return null;
    // Donnée d'appoint (réglages) : pas de mention « Données du … » pour elle seule.
    if (!rule.support) markServedFromCopy(path, copy.savedAt, route);
    return { data: tagCopy(copy.data, copy.savedAt) };
  };

  const headers = new Headers(init.headers);
  // Ne pas forcer JSON sur FormData (boundary multipart requis par le navigateur)
  if (
    init.body &&
    !headers.has("Content-Type") &&
    !(init.body instanceof FormData)
  ) {
    headers.set("Content-Type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "include",
      ...init,
      headers,
    });
  } catch (error) {
    // Annulation voulue par l'appelant : transmise telle quelle.
    if (isAbort(error)) throw error;
    const copy = await fromCopy();
    if (copy) return copy.data;
    throw new OfflineError();
  }

  if (!res.ok && SERVER_DOWN.has(res.status)) {
    const copy = await fromCopy();
    if (copy) return copy.data;
  }

  if (!res.ok) {
    let message = statusMessage(res.status);
    let code: string | undefined;
    let fieldErrors: Record<string, string> | undefined;
    let data: unknown;
    try {
      const body = await res.json();
      data = body;
      if (typeof body.error === "string") message = body.error;
      else if (body.error?.formErrors) {
        message = "Données invalides";
        // Erreurs zod par champ (error.flatten()) : premier message de chaque champ.
        const entries = Object.entries((body.error.fieldErrors ?? {}) as Record<string, string[] | undefined>)
          .filter(([, list]) => list?.length)
          .map(([key, list]) => [key, list![0]!] as const);
        if (entries.length) fieldErrors = Object.fromEntries(entries);
      }
      // Erreurs zod sous forme de liste (espace Site) : { path: "testimonial.text", message }.
      if (Array.isArray(body.issues)) {
        const issues = body.issues as Array<{ path?: unknown; message?: unknown }>;
        fieldErrors = {};
        for (const i of issues) {
          const key = String(i.path ?? "");
          if (key && !(key in fieldErrors)) fieldErrors[key] = String(i.message ?? "");
        }
      }
      if (typeof body.code === "string") code = body.code;
    } catch {
      /* ignore */
    }
    // status et code (ex. « stripe_mode_change ») : l'appelant peut demander une confirmation.
    // data : corps de la réponse (ex. fiche existante d'un 409 « client_exists »).
    throw Object.assign(new Error(message || statusMessage(res.status)), { status: res.status, code, fieldErrors, data });
  }

  if (method !== "GET" && path.startsWith("/api/site/")) {
    window.dispatchEvent(new CustomEvent(SITE_CHANGED_EVENT));
  }
  if (res.status === 204) return undefined as T;
  if (responseType === "blob") return (await readBody(() => res.blob())) as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const data = (await readBody(() => res.json())) as T;
    if (rule) {
      markFresh(path);
      // Copie en arrière-plan : un échec d'écriture locale ne bloque jamais l'écran.
      void saveCopy(path, rule.sanitize(data)).catch(() => undefined);
    }
    return data;
  }
  return undefined as T;
}

async function readBody<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isAbort(error)) throw error;
    // Corps coupé en route : le réseau est tombé pendant la lecture de la réponse.
    throw new OfflineError();
  }
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Message quand le serveur ne fournit pas le sien : jamais le statusText anglais du navigateur. */
export function statusMessage(status: number): string {
  if (status === 401) return "Session expirée. Reconnectez-vous.";
  if (status === 403) return "Action non autorisée.";
  if (status === 404) return "Élément introuvable.";
  if (status === 413) return "Fichier trop volumineux.";
  if (status === 429) return "Trop de requêtes. Patientez un instant puis réessayez.";
  if (status === 502 || status === 503 || status === 504) return "Le serveur de l'ERP ne répond pas. Réessayez dans un instant.";
  if (status >= 500) return "Erreur du serveur. Réessayez ; si le problème revient, notez l'action concernée.";
  return `Requête refusée (erreur ${status}).`;
}

export { formatEUR, formatDate } from "./format";
