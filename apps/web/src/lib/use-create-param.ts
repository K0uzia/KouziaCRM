import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

export type CreateParams = { clientId?: string };

/**
 * Ouvre un formulaire de création quand la page est atteinte via `?new=1`
 * (option `clientId` : client présélectionné, ex. depuis une fiche client),
 * puis retire les paramètres pour qu'un rafraîchissement ne les rejoue pas.
 */
export function useCreateParam(open: (params: CreateParams) => void) {
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (params.get("new") !== "1") return;
    const clientId = params.get("clientId")?.trim() || undefined;
    const next = new URLSearchParams(params);
    next.delete("new");
    next.delete("clientId");
    setParams(next, { replace: true });
    open({ clientId });
  }, [params, setParams, open]);
}
