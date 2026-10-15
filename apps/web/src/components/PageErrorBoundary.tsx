import type { ReactNode } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

const RELOAD_FLAG = "kouzia:chunk-reload-at";

/** Module d'une page introuvable : version de l'ERP remplacée pendant que l'onglet était ouvert. */
function isStaleChunk(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message);
}

/**
 * Après une mise à jour, les anciens fichiers de pages n'existent plus : un seul rechargement
 * automatique par minute (drapeau en sessionStorage), jamais de boucle.
 */
export function reloadOnceForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_FLAG) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

function Fallback({ error }: FallbackProps) {
  const stale = isStaleChunk(error);
  return (
    <Card role="alert" className="mx-auto my-6 max-w-xl space-y-3 p-5">
      <h1 className="text-lg font-semibold">{stale ? "Une nouvelle version de l'ERP est disponible" : "Cet écran n'a pas pu s'afficher"}</h1>
      <p className="text-sm text-[var(--muted)]">
        {stale
          ? "L'ERP a été mis à jour pendant que cette page était ouverte. Rechargez pour continuer."
          : "Une erreur est survenue à l'affichage. Rechargez la page ; si le problème revient, notez l'écran concerné."}
      </p>
      <Button type="button" onClick={() => window.location.reload()}>
        Recharger
      </Button>
    </Card>
  );
}

/** Erreur de rendu ou page introuvable : message dans le contenu, menu et navigation conservés. */
export function PageErrorBoundary({ children, resetKey }: { children: ReactNode; resetKey?: string }) {
  return (
    <ErrorBoundary
      FallbackComponent={Fallback}
      resetKeys={[resetKey]}
      onError={(error) => {
        if (isStaleChunk(error)) reloadOnceForStaleChunk();
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
