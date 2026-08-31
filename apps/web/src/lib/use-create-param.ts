import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Ouvre un formulaire de création quand la page est atteinte via `?new=1`,
 * puis retire le paramètre pour qu'un rafraîchissement ne le rejoue pas.
 */
export function useCreateParam(open: () => void) {
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    if (params.get("new") !== "1") return;
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
    open();
  }, [params, setParams, open]);
}
