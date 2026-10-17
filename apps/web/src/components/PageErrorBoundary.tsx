import { useEffect, useState, type ReactNode } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { isOnline, isStaleChunk, onReconnect, serverReachable } from "@/lib/network";

const RELOAD_FLAG = "kouzia:chunk-reload-at";
/** Fichier d'écran manquant pendant une coupure : nouvel essai à ce rythme si l'événement « online » ne vient pas. */
const OFFLINE_RETRY_MS = 15_000;

/**
 * Après une mise à jour, les anciens fichiers de pages n'existent plus : un seul rechargement
 * automatique par minute (drapeau en sessionStorage), jamais de boucle.
 */
function reloadOnceForStaleChunk(): boolean {
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

type StalePhase = "checking" | "offline" | "update";

/**
 * Fichier d'écran introuvable : périmé (mise à jour) seulement si le réseau et le serveur répondent. Sinon l'écran
 * n'a simplement pas encore été chargé : message hors ligne, puis rechargement dès que le serveur répond à nouveau
 * (React.lazy garde l'échec en mémoire, seul un rechargement relance l'import).
 */
function useStalePhase(stale: boolean): StalePhase {
  const [phase, setPhase] = useState<StalePhase>("checking");
  useEffect(() => {
    if (!stale) return;
    let cancelled = false;
    let timer: number | undefined;
    const retry = async () => {
      if (cancelled || !(await serverReachable()) || cancelled) return;
      window.location.reload();
    };
    void (async () => {
      const reachable = isOnline() && (await serverReachable());
      if (cancelled) return;
      if (reachable) {
        if (!reloadOnceForStaleChunk()) setPhase("update");
        return;
      }
      setPhase("offline");
      timer = window.setInterval(() => {
        if (isOnline()) void retry();
      }, OFFLINE_RETRY_MS);
    })();
    const stop = onReconnect(() => void retry());
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      stop();
    };
  }, [stale]);
  return phase;
}

function Fallback({ error }: FallbackProps) {
  const stale = isStaleChunk(error);
  const phase = useStalePhase(stale);

  if (stale && phase === "checking") {
    return (
      <div role="status" className="flex min-h-[40vh] items-center justify-center text-sm text-[var(--muted)]">
        Chargement…
      </div>
    );
  }
  if (stale && phase === "offline") {
    return (
      <Card role="status" className="mx-auto my-6 max-w-xl space-y-3 p-5">
        <h1 className="text-lg font-semibold">Écran indisponible hors ligne</h1>
        <p className="text-sm text-[var(--muted)]">Cet écran n'est pas encore disponible hors ligne. Il s'ouvrira dès le retour du réseau.</p>
      </Card>
    );
  }
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
    <ErrorBoundary FallbackComponent={Fallback} resetKeys={[resetKey]}>
      {children}
    </ErrorBoundary>
  );
}
