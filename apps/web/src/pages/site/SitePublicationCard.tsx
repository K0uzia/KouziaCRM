import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faCloudArrowUp } from "@fortawesome/free-solid-svg-icons";
import { api, SITE_CHANGED_EVENT } from "@/lib/api";
import { SITE_PUBLISH_OPEN_EVENT } from "@/components/site/SitePublishBar";
import { formatDate, formatTime } from "@/lib/format";
import { Badge } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import type { SiteState } from "./shared";

export type FileChange = { path: string; change: "added" | "modified" | "deleted"; label?: string };
export type SitePublication = {
  id: string;
  status: "PREPARING" | "COMMITTED" | "DISPATCHED" | "BUILDING" | "DEPLOYED" | "LIVE" | "FAILED" | "NOOP";
  /** Verrou pris : une autre publication est refusée. */
  running: boolean;
  /** Déploiement encore suivi : l'écran se rafraîchit. */
  watching: boolean;
  /** « Rappel non reçu : voir le run. » quand le run est fini sans rappel de l'Action. */
  notice: string | null;
  changes: FileChange[];
  /** Mêmes libellés que le récapitulatif et le message de commit (calculés par l'API). */
  lines: string[];
  summary: string;
  commitSha: string | null;
  commitUrl: string | null;
  runUrl: string | null;
  error: string | null;
  startedAt: string;
  liveAt: string | null;
};

export const PUBLICATION_STATUS: Record<SitePublication["status"], { label: string; tone: "neutral" | "green" | "blue" | "amber" | "red" }> = {
  PREPARING: { label: "Préparation", tone: "blue" },
  COMMITTED: { label: "Enregistré dans le dépôt", tone: "blue" },
  DISPATCHED: { label: "Déploiement lancé", tone: "blue" },
  BUILDING: { label: "Construction du site", tone: "blue" },
  DEPLOYED: { label: "Déployé, vérification", tone: "blue" },
  LIVE: { label: "En ligne", tone: "green" },
  FAILED: { label: "Échec", tone: "red" },
  NOOP: { label: "Déjà à jour", tone: "neutral" },
};
const when = (iso: string) => `${formatDate(iso)} à ${formatTime(iso)}`;

/**
 * Publication vers kouzia.com : récapitulatif avant confirmation, état en direct (rafraîchi toutes les
 * 3 s tant qu'une publication est suivie), historique des 20 dernières.
 */
export function SitePublicationCard({ state, onPublished }: { state: SiteState; onPublished: () => void }) {
  const [history, setHistory] = useState<SitePublication[] | null>(null);
  const timer = useRef<number | null>(null);

  async function loadHistory() {
    try {
      setHistory(await api<SitePublication[]>("/api/site/publications"));
    } catch {
      setHistory((h) => h ?? []);
    }
  }
  useEffect(() => {
    void loadHistory();
  }, []);

  const current = history?.[0] ?? null;
  const running = Boolean(current?.running);
  const watching = running || Boolean(current?.watching);
  useEffect(() => {
    if (!watching) return;
    timer.current = window.setInterval(() => void loadHistory(), 3000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [watching]);

  // Une publication lancée depuis la barre du haut : l'historique et l'état de la page suivent.
  useEffect(() => {
    const onChanged = () => {
      void loadHistory();
      onPublished();
    };
    window.addEventListener(SITE_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SITE_CHANGED_EVENT, onChanged);
  }, [onPublished]);

  const blocked = !state.github.token.set
    ? "Enregistrer d'abord un jeton GitHub (Connexion)."
    : state.issues.length
      ? "Corriger d'abord les anomalies du contrôle avant publication."
      : running
        ? "Une publication est en cours."
        : null;
  const { unpublished = null, live = null } = state.publication ?? {};

  return (
    <section aria-labelledby="site-publication" className="ui-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="site-publication" className="text-base font-semibold">
            Publication
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {unpublished === true
              ? "Des modifications ne sont pas encore sur kouzia.com."
              : unpublished === false
                ? live
                  ? "kouzia.com a le contenu saisi ici."
                  : "Le dépôt du site a le contenu saisi ici ; sa mise en ligne sur kouzia.com n'est pas confirmée."
                : "Publier enregistre le contenu dans le dépôt du site, qui se reconstruit puis se déploie."}
          </p>
        </div>
        {/* Même panneau que le bouton Publier de la barre du haut : changements, anomalies, mise en ligne. */}
        <Button type="button" className="min-h-11 shrink-0" aria-haspopup="dialog" onClick={() => window.dispatchEvent(new CustomEvent(SITE_PUBLISH_OPEN_EVENT))}>
          <FontAwesomeIcon icon={faCloudArrowUp} className="h-4 w-4" aria-hidden />
          Publier…
        </Button>
      </div>
      {blocked && !running ? <p className="mt-2 text-sm text-[var(--warning)]">{blocked}</p> : null}

      {current ? (
        <div className="mt-4 rounded-[var(--radius-sm)] bg-[var(--surface-raised)] p-3 text-sm" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={PUBLICATION_STATUS[current.status].tone}>{PUBLICATION_STATUS[current.status].label}</Badge>
            <span className="text-[var(--muted)]">{when(current.startedAt)}</span>
          </div>
          {current.summary ? <p className="mt-2 break-words">{current.summary}</p> : null}
          {current.error ? <p className="mt-2 text-[var(--danger)]">{current.error}</p> : null}
          {current.notice ? <p className="mt-2 text-[var(--warning)]">{current.notice}</p> : null}
          {current.watching ? (
            <p className="mt-2 text-[var(--muted)]">Suivi en direct : le site est en ligne quand kouzia.com montre ce commit (quelques minutes).</p>
          ) : null}
          <PublicationLinks p={current} />
        </div>
      ) : null}

      {history && history.length > 1 ? (
        <details className="mt-4">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium">Historique des publications</summary>
          <ul className="mt-2 divide-y divide-[var(--border)]">
            {history.slice(1).map((p) => (
              <li key={p.id} className="flex flex-col gap-1 py-2.5 text-sm sm:flex-row sm:items-center sm:gap-3">
                <span className="shrink-0 text-[var(--muted)] sm:w-40">{when(p.startedAt)}</span>
                <Badge tone={PUBLICATION_STATUS[p.status].tone} className="self-start sm:self-auto">
                  {PUBLICATION_STATUS[p.status].label}
                </Badge>
                <span className="min-w-0 flex-1 break-words">{p.error ?? p.summary}</span>
                <PublicationLinks p={p} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

    </section>
  );
}

export function PublicationLinks({ p }: { p: SitePublication }) {
  if (!p.commitUrl && !p.runUrl) return null;
  return (
    <span className="flex flex-wrap gap-x-4">
      {p.commitUrl ? (
        <a href={p.commitUrl} target="_blank" rel="noreferrer" className="link inline-flex min-h-11 items-center gap-1.5 text-sm">
          Commit {p.commitSha?.slice(0, 7)}
          <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3" aria-hidden />
          <span className="sr-only">(nouvel onglet)</span>
        </a>
      ) : null}
      {p.runUrl ? (
        <a href={p.runUrl} target="_blank" rel="noreferrer" className="link inline-flex min-h-11 items-center gap-1.5 text-sm">
          Déploiement
          <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3" aria-hidden />
          <span className="sr-only">(nouvel onglet)</span>
        </a>
      ) : null}
    </span>
  );
}
