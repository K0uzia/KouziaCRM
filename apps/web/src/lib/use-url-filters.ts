import { useSearchParams } from "react-router-dom";

/**
 * Filtres d'une liste gardés dans l'URL (?type=, ?statut=, ?q=) : un lien ou un retour arrière rend la même vue.
 * Valeur inconnue ou absente : la valeur par défaut, jamais écrite dans l'URL.
 */
export function useUrlFilters() {
  const [params, setParams] = useSearchParams();

  function pick<T extends string>(key: string, ids: readonly T[], fallback: T): T {
    const raw = params.get(key);
    return (ids as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  }

  /** Change plusieurs filtres d'un coup ; null ou "" retire la clé. Remplace l'entrée d'historique. */
  function set(changes: Record<string, string | null>) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );
  }

  return { params, pick, set, text: (key: string) => params.get(key) ?? "" };
}
