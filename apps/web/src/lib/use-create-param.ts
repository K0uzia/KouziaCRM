import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

export type CreateParams = {
  clientId?: string;
  /** `?new=<type>` : type à créer choisi d'avance (ex. Prestations : service, option, pack, abonnement). */
  type?: string;
};

/**
 * Ouvre un formulaire de création quand la page est atteinte via `?new=1` (ou `?new=<type>`)
 * (option `clientId` : client présélectionné, ex. depuis une fiche client),
 * puis retire les paramètres pour qu'un rafraîchissement ne les rejoue pas.
 */
export function useCreateParam(open: (params: CreateParams) => void) {
  const [params, setParams] = useSearchParams();
  // `open` change à chaque rendu chez l'appelant : hors des dépendances, sinon l'effet
  // se rejoue avant que `new` ne disparaisse de l'URL et boucle (« Maximum update depth »).
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    const wanted = params.get("new")?.trim();
    if (!wanted) return;
    const clientId = params.get("clientId")?.trim() || undefined;
    const next = new URLSearchParams(params);
    next.delete("new");
    next.delete("clientId");
    setParams(next, { replace: true });
    openRef.current({ clientId, ...(wanted !== "1" ? { type: wanted } : {}) });
  }, [params, setParams]);
}
