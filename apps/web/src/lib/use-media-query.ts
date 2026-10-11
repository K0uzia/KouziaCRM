import { useSyncExternalStore } from "react";

/**
 * Vrai si la requête média correspond (ex. « (min-width: 40rem) »), mis à jour au redimensionnement.
 * Pour ce que le CSS ne peut pas changer, comme le texte d'une <option>.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
