import { api } from "@/lib/api";
import { OfflineError } from "@/lib/network";
import { copiedAt } from "@/lib/offline/served";

// Lecture partagée de /api/settings : une requête en vol ou partie il y a moins de 3 s sert tous les
// demandeurs (modules au démarrage, écran Réglages ouvert en même temps, préchargement de la route).
// Les réponses sont en lecture seule pour les consommateurs : copier avant de modifier.
const FRESH_MS = 3000;
let shared: { at: number; promise: Promise<unknown> } | null = null;

/**
 * complete : réglages entiers exigés (écran Réglages). La copie hors ligne n'en garde qu'un petit sous-ensemble :
 * servie à cet écran, elle ferait croire à des réglages vides. Elle est alors refusée comme une coupure.
 */
export function fetchSettings<T>({ force = false, complete = false }: { force?: boolean; complete?: boolean } = {}): Promise<T> {
  if (force || !shared || Date.now() - shared.at > FRESH_MS) {
    const promise = api<T>("/api/settings");
    const entry = { at: Date.now(), promise };
    shared = entry;
    promise.catch(() => {
      if (shared === entry) shared = null;
    });
  }
  const promise = shared.promise as Promise<T>;
  if (!complete) return promise;
  return promise.then((settings) => {
    if (copiedAt(settings) !== null) throw new OfflineError();
    return settings;
  });
}
