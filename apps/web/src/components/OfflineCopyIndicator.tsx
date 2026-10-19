import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/Button";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { cancelOfflineCopy, hideCopyPanel, useOfflineCopy } from "@/lib/offline/sync";

/**
 * Indicateur discret de la copie hors ligne, dans la barre du haut (remplace la fenêtre) : petit anneau avec le
 * pourcentage de l'étape et, dès 640 px, « Copie 32/47 ». Un clic ouvre le détail (« Clients 32 sur 47 »,
 * Annuler, Masquer) ; Échap ou un clic ailleurs le referme et rend le focus au bouton. Rien ne prend le focus de
 * lui-même ; l'avancement est annoncé poliment, par quart, sans bavarder.
 */
export function OfflineCopyIndicator() {
  const copy = useOfflineCopy();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (!copy.visible || !copy.running) return null;
  const total = Math.max(copy.total, 0);
  const percent = total > 0 ? Math.round((copy.done / total) * 100) : 0;
  const step = copy.phase && total > 0 ? `${copy.phase} ${copy.done} sur ${total}` : "Préparation…";
  // Annonce par quart d'étape (0, 25, 50, 75 %) : un lecteur d'écran n'énonce pas chaque élément copié.
  const announced = copy.phase ? `Copie hors ligne : ${copy.phase.toLowerCase()}, ${Math.floor(percent / 25) * 25} %` : "Copie hors ligne en préparation";

  const close = (focus: boolean) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      close(true);
    }
  };

  return (
    <div ref={wrapper} className="relative" onKeyDown={onKeyDown} data-offline-copy-indicator>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={detailId}
        aria-label={`Copie hors ligne en cours : ${step}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] px-1.5 text-sm text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        <ProgressRing value={copy.done} max={total || 1} size="sm" label="Avancement de la copie hors ligne" />
        <span className="hidden tabular-nums sm:inline" aria-hidden>
          Copie {total > 0 ? `${copy.done}/${total}` : "…"}
        </span>
      </button>
      <span role="status" className="sr-only">
        {announced}
      </span>
      {open ? (
        <section
          id={detailId}
          aria-label="Détail de la copie hors ligne"
          className="absolute right-0 top-full z-50 mt-2 w-[min(18rem,calc(100vw-1.5rem))] rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow)]"
        >
          <div className="flex items-center gap-3">
            <ProgressRing value={copy.done} max={total || 1} size="md" label={`Copie hors ligne, ${copy.phase?.toLowerCase() ?? "préparation"}`} />
            <div className="min-w-0">
              <p className="text-sm font-semibold">Copie hors ligne en cours</p>
              <p className="text-sm text-[var(--muted)]">{step}</p>
            </div>
          </div>
          <p className="mt-2 text-xs text-[var(--muted)]">La copie continue en arrière-plan : vous pouvez travailler pendant ce temps.</p>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                close(false);
                hideCopyPanel();
              }}
            >
              Masquer
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                close(false);
                cancelOfflineCopy();
              }}
            >
              Annuler la copie
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
