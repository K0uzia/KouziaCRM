import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { onReconnect } from "@/lib/network";

function RetryOnReconnect({ onRetry }: { onRetry: () => void }) {
  useEffect(() => onReconnect(onRetry), [onRetry]);
  return null;
}

/**
 * Élément secondaire de la barre du haut chargé à part (palette Ctrl K, barre de publication du site) : s'il
 * échoue (fichier non chargé hors ligne, erreur d'affichage), il disparaît seul, sans remplacer toute l'app par le
 * cadre d'erreur. Nouvel essai au retour du réseau (React.lazy garde l'échec en mémoire : un nouveau lazy repart).
 */
export function optionalLazy<P extends object>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  return function OptionalLazy(props: P) {
    const [attempt, setAttempt] = useState(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const Component = useMemo(() => lazy(() => load().then((c) => ({ default: c }))), [attempt]);
    return (
      <ErrorBoundary
        resetKeys={[attempt]}
        fallbackRender={() => <RetryOnReconnect onRetry={() => setAttempt((n) => n + 1)} />}
      >
        <Suspense fallback={null}>
          <Component {...props} />
        </Suspense>
      </ErrorBoundary>
    );
  };
}
