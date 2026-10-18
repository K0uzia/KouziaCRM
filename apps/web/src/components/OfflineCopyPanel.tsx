import { useId, type KeyboardEvent } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCloudArrowDown, faXmark } from "@fortawesome/free-solid-svg-icons";
import { Button } from "@/components/ui/Button";
import { cancelOfflineCopy, hideCopyPanel, useOfflineCopy } from "@/lib/offline/sync";

/**
 * Fenêtre de progression de la copie hors ligne : non bloquante (région avec un état annoncé, pas une modale),
 * elle ne prend pas le focus. « Masquer » la referme, la copie continue ; « Annuler » l'arrête ; Échap la referme
 * quand le focus y est. Au téléphone, pleine largeur au-dessus des onglets du bas.
 */
export function OfflineCopyPanel() {
  const copy = useOfflineCopy();
  const titleId = useId();
  if (!copy.visible || !copy.running) return null;
  const label = copy.phase && copy.total > 0 ? `${copy.phase} ${copy.done} sur ${copy.total}` : "Préparation…";
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      hideCopyPanel();
    }
  };
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow)] sm:inset-x-auto sm:right-6 sm:w-[min(24rem,calc(100vw-3rem))] lg:bottom-6"
    >
      <div className="flex items-start gap-3">
        <FontAwesomeIcon icon={faCloudArrowDown} className="mt-1 h-4 w-4 shrink-0 text-[var(--primary)]" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">
            Copie hors ligne en cours
          </h2>
          <p role="status" aria-live="polite" className="mt-0.5 text-sm text-[var(--muted)]">
            {label}
          </p>
        </div>
        <Button variant="ghost" className="-mr-2 -mt-2 px-0" aria-label="Masquer la copie hors ligne (elle continue)" onClick={hideCopyPanel}>
          <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      <progress
        className="mt-3 h-2 w-full accent-[var(--primary)]"
        max={Math.max(copy.total, 1)}
        value={copy.done}
        aria-label={`Avancement de la copie : ${label}`}
      />
      <div className="mt-3 flex justify-end">
        <Button variant="secondary" onClick={cancelOfflineCopy}>
          Annuler la copie
        </Button>
      </div>
    </section>
  );
}
