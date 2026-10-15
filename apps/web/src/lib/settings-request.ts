import { api } from "@/lib/api";

// Lecture partagée de /api/settings : une requête en vol ou partie il y a moins de 3 s sert tous les
// demandeurs (modules au démarrage, écran Réglages ouvert en même temps, préchargement de la route).
// Les réponses sont en lecture seule pour les consommateurs : copier avant de modifier.
const FRESH_MS = 3000;
let shared: { at: number; promise: Promise<unknown> } | null = null;

export function fetchSettings<T>({ force = false }: { force?: boolean } = {}): Promise<T> {
  if (force || !shared || Date.now() - shared.at > FRESH_MS) {
    const promise = api<T>("/api/settings");
    const entry = { at: Date.now(), promise };
    shared = entry;
    promise.catch(() => {
      if (shared === entry) shared = null;
    });
  }
  return shared.promise as Promise<T>;
}
