import { useCallback, useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowRotateRight, faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import { statusMessage } from "@/lib/api";
import { errorMessage, OFFLINE_MESSAGE, useOnline } from "@/lib/network";
import { Button } from "@/components/ui/Button";
import { PdfThumbnail } from "@/components/documents/PdfThumbnail";

/** Pause de frappe avant le rendu (D3) : un PDF par pause, pas un par touche. « Actualiser l'aperçu » n'attend pas. */
const DEBOUNCE_MS = 1500;
/** Au-delà, le rendu est jugé lent : l'aperçu ne se met plus à jour seul, seulement par « Actualiser l'aperçu ». */
const SLOW_RENDER_MS = 1000;

type State =
  | { status: "loading" }
  | { status: "paused"; message: string }
  | { status: "error"; message: string }
  | { status: "stale" }
  | { status: "ready" };

/**
 * Aperçu d'un devis ou d'une facture avant création : PDF rendu par l'API à partir du brouillon du
 * formulaire, 1,5 s après la dernière frappe si le rendu précédent a pris moins d'une seconde, sinon à la demande
 * seulement (la requête précédente est annulée). Rien n'est enregistré.
 */
export function DocumentPreview({
  body,
  pausedReason,
  active,
  kindLabel,
}: {
  /** Brouillon sérialisé (corps de la création) ; null tant qu'il est incomplet. */
  body: string | null;
  /** Ce qui manque pour afficher l'aperçu, quand body est null. */
  pausedReason: string;
  /** Faux quand l'aperçu n'est pas affiché (mobile, fenêtre fermée) : aucune requête. */
  active: boolean;
  kindLabel: string;
}) {
  const online = useOnline();
  const [state, setState] = useState<State>(() => (body ? { status: "loading" } : { status: "paused", message: pausedReason }));
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [pages, setPages] = useState(1);
  const [retry, setRetry] = useState(0);
  // Demande explicite (« Actualiser l'aperçu ») : rendu sans attendre la pause de frappe.
  const [refresh, setRefresh] = useState(0);
  const servedRefresh = useRef(0);
  // Dernier rendu lent (plus d'une seconde, mesuré) : plus de mise à jour automatique jusqu'à un rendu rapide.
  const slow = useRef(false);
  const rendered = useRef(false);
  const onThumbnailError = useCallback((message: string) => setState({ status: "error", message }), []);

  useEffect(() => {
    if (!active) return;
    if (!body) {
      setState({ status: "paused", message: pausedReason });
      return;
    }
    if (!online) {
      setState({ status: "error", message: OFFLINE_MESSAGE });
      return;
    }
    const ctrl = new AbortController();
    const immediate = refresh !== servedRefresh.current;
    servedRefresh.current = refresh;
    if (!immediate && slow.current && rendered.current) {
      setState({ status: "stale" });
      return;
    }
    const timer = window.setTimeout(() => {
      setState({ status: "loading" });
      const startedAt = performance.now();
      fetch("/api/invoices/preview.pdf", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      })
        .then(async (res) => {
          if (res.ok) {
            const buffer = await res.arrayBuffer();
            slow.current = performance.now() - startedAt > SLOW_RENDER_MS;
            rendered.current = true;
            setPdf(buffer);
            setState({ status: "ready" });
            return;
          }
          const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
          const message = typeof json?.error === "string" ? json.error : statusMessage(res.status);
          // Saisie en cours (ligne incomplète) : l'aperçu attend, ce n'est pas une panne.
          if (res.status === 400) {
            setState({
              status: "paused",
              message:
                message === "Données invalides"
                  ? "Aperçu en pause : complétez chaque ligne (désignation, quantité, prix)."
                  : `Aperçu en pause : ${message}`,
            });
          } else {
            setState({ status: "error", message });
          }
        })
        .catch((e: unknown) => {
          if (ctrl.signal.aborted) return;
          setState({ status: "error", message: errorMessage(e, "Aperçu indisponible.") });
        });
    }, immediate ? 0 : DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [body, pausedReason, active, online, retry, refresh]);

  function openPdf() {
    if (!pdf) return;
    const url = URL.createObjectURL(new Blob([pdf], { type: "application/pdf" }));
    window.open(url, "_blank", "noopener");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return (
    <div className="space-y-3">
      <p className="min-h-5 text-xs text-[var(--muted)]" role="status" aria-live="polite">
        {state.status === "loading"
          ? "Mise à jour de l'aperçu…"
          : state.status === "paused"
            ? state.message
            : state.status === "stale"
              ? "Aperçu à actualiser : le dernier rendu a été lent, il ne se met plus à jour seul."
              : state.status === "ready"
              ? `Aperçu à jour, numéro attribué à l'émission${pages > 1 ? ` · page 1 sur ${pages}` : ""}.`
              : null}
      </p>
      {state.status === "error" ? (
        <div className="space-y-2 rounded-[var(--radius-sm)] bg-[var(--danger-soft)] px-3 py-3 text-sm text-[var(--danger)]" role="alert">
          <p>{state.message}</p>
          {online ? (
            <Button variant="secondary" onClick={() => setRetry((n) => n + 1)}>
              Réessayer
            </Button>
          ) : null}
        </div>
      ) : null}
      {pdf ? (
        <div className={`transition-opacity duration-150 ${state.status === "ready" ? "" : "opacity-60"}`}>
          <PdfThumbnail
            pdf={pdf}
            label={`Première page de l'aperçu (${kindLabel.toLowerCase()})`}
            errorMessage="La miniature n'a pas pu être dessinée : ouvrez l'aperçu en grand."
            onPages={setPages}
            onError={onThumbnailError}
          />
        </div>
      ) : state.status === "loading" ? (
        <div className="aspect-[210/297] w-full animate-pulse rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] motion-reduce:animate-none" aria-hidden />
      ) : null}
      <div className="grid gap-2">
        <Button variant="secondary" className="w-full" disabled={!body || !online || state.status === "loading"} onClick={() => setRefresh((n) => n + 1)}>
          <FontAwesomeIcon icon={faArrowRotateRight} className="h-3.5 w-3.5" aria-hidden />
          Actualiser l&apos;aperçu
        </Button>
        <Button variant="secondary" className="w-full" disabled={!pdf} onClick={openPdf}>
          <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3.5 w-3.5" aria-hidden />
          Ouvrir l&apos;aperçu en grand
        </Button>
      </div>
    </div>
  );
}
