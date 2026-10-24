import { useEffect } from "react";

/**
 * Saisies non enregistrées de la page : alerte du navigateur avant de quitter, et question avant le rechargement d'une
 * mise à jour (« Recharger », VersionNotice). Un écran avec saisie en cours appelle useUnsavedGuard(true).
 */
let guards = 0;
let leaving = false;

export function useUnsavedGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    guards += 1;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!leaving) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      guards -= 1;
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [active]);
}

/** Saisie en cours : écran signalé, ou fenêtre ouverte avec un formulaire (création, modification). */
export function hasUnsavedChanges(): boolean {
  if (guards > 0) return true;
  return typeof document !== "undefined" && document.querySelector('[role="dialog"] form') !== null;
}

/** Départ confirmé par la personne (« Recharger quand même ») : plus de seconde alerte du navigateur. */
export function allowLeave(): void {
  leaving = true;
}
