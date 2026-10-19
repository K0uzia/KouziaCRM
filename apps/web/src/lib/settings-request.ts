import { api } from "@/lib/api";
import { copiedAt, markServedFromCopy } from "@/lib/offline/served";

// Lecture partagée de /api/settings : une requête en vol ou partie il y a moins de 3 s sert tous les
// demandeurs (modules au démarrage, écran Réglages ouvert en même temps, préchargement de la route).
// Les réponses sont en lecture seule pour les consommateurs : copier avant de modifier.
const FRESH_MS = 3000;
let shared: { at: number; promise: Promise<unknown> } | null = null;

/**
 * complete : réglages entiers exigés (écran Réglages). Hors ligne, la copie (sans secret, banque ni serveur de
 * messagerie) est servie, et l'écran est marqué « Données du … » : il passe en lecture seule (useReadOnly), si bien
 * qu'aucun enregistrement ne peut renvoyer un formulaire auquel manquent ces champs.
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
    const at = copiedAt(settings);
    if (at !== null) markServedFromCopy("/api/settings", at, window.location.pathname);
    return settings;
  });
}
