import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCloudArrowUp } from "@fortawesome/free-solid-svg-icons";
import { api, SITE_CHANGED_EVENT } from "@/lib/api";
import { Badge } from "@/components/ui/Card";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { PUBLICATION_STATUS, PublicationLinks, type SitePublication } from "@/pages/site/SitePublicationCard";
import type { SiteIssue } from "@/pages/site/shared";

/** Ouvre le panneau de publication depuis un autre écran (carte Publication de la vue d'ensemble). */
export const SITE_PUBLISH_OPEN_EVENT = "kouzia:site-publish-open";

type Change = {
  collection: "projects" | "reviews" | "references" | "faq" | "texts" | "order";
  id: string;
  label: string;
  state: "new" | "modified" | "removal" | "order";
  to: string;
};
type Changes = {
  changes: Change[];
  undetailed: boolean;
  unpublished: boolean | null;
  live: boolean | null;
  last: SitePublication | null;
  issues: SiteIssue[];
  tokenSet: boolean;
};

const GROUP: Record<Change["collection"], string> = {
  projects: "Réalisations",
  reviews: "Témoignages",
  references: "Références",
  faq: "FAQ",
  texts: "Textes du site",
  order: "Ordre",
};
const CHANGE: Record<Change["state"], { label: string; tone: "blue" | "amber" | "red" | "neutral" }> = {
  new: { label: "Nouveau", tone: "blue" },
  modified: { label: "Modifié", tone: "amber" },
  removal: { label: "Retrait", tone: "red" },
  order: { label: "Ordre", tone: "neutral" },
};
/** Écran où corriger une anomalie, selon le fichier du site concerné. */
const ISSUE_ROUTE: Record<string, string> = {
  infos: "/site/coordonnees",
  textes: "/site/accroche",
  faq: "/site/faq",
  realisations: "/site/realisations",
  avis: "/site/avis",
  references: "/site/references",
};

/**
 * Publication du site depuis la barre du haut de l'espace Site : état (« En ligne », « 3 à publier »), bouton
 * Publier avec compteur, panneau latéral (anomalies bloquantes, changements groupés, dernière publication, mise en
 * ligne). Compteur recalculé après chaque écriture dans l'espace Site, à chaque écran et au retour sur l'onglet ;
 * toutes les 3 s tant qu'une publication est suivie.
 */
export default function SitePublishBar() {
  const { pathname } = useLocation();
  const [data, setData] = useState<Changes | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<Changes>("/api/site/changes"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, pathname]);
  useEffect(() => {
    const reload = () => void load();
    const openPanel = () => setOpen(true);
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener(SITE_CHANGED_EVENT, reload);
    window.addEventListener(SITE_PUBLISH_OPEN_EVENT, openPanel);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(SITE_CHANGED_EVENT, reload);
      window.removeEventListener(SITE_PUBLISH_OPEN_EVENT, openPanel);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const watching = Boolean(data?.last?.running || data?.last?.watching);
  useEffect(() => {
    if (!watching) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [watching, load]);

  const count = data?.changes.length ?? 0;
  const pending = count > 0 || Boolean(data?.undetailed);
  const running = Boolean(data?.last?.running);
  const failedLast = data?.last?.status === "FAILED" && pending;
  const state = !data
    ? null
    : running
      ? { label: "Publication en cours", tone: "var(--info)" }
      : failedLast
        ? { label: "Échec de publication", tone: "var(--danger)" }
        : pending
          ? { label: count ? `${count} à publier` : "Modifications à publier", tone: "var(--warning)" }
          : data.live
            ? { label: "En ligne", tone: "var(--success)" }
            : data.unpublished === false
              ? { label: "Dans le dépôt du site", tone: "var(--info)" }
              : null;

  const blocked = !data
    ? "Chargement…"
    : !data.tokenSet
      ? "Enregistrer d'abord un jeton GitHub (Connexion au dépôt)."
      : data.issues.length
        ? "Corriger d'abord les anomalies ci-dessus."
        : running
          ? "Une publication est en cours."
          : !pending
            ? "Rien à publier : kouzia.com a déjà ce contenu."
            : null;

  async function publish() {
    setBusy(true);
    try {
      const p = await api<SitePublication>("/api/site/publish", { method: "POST" });
      if (p.status === "NOOP") toast.success("Rien à publier : kouzia.com a déjà ce contenu.");
      else if (p.status === "FAILED") toast.error(p.error ?? "Publication en échec");
      else toast.success("Contenu enregistré dans le dépôt du site, mise en ligne en cours.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Publication impossible");
    } finally {
      setBusy(false);
      await load();
    }
  }

  const groups = Object.entries(
    (data?.changes ?? []).reduce<Record<string, Change[]>>((acc, c) => ((acc[c.collection] ??= []).push(c), acc), {}),
  ) as Array<[Change["collection"], Change[]]>;
  const buttonLabel = pending ? `Publier, ${count ? `${count} modification${count > 1 ? "s" : ""} à publier` : "modifications à publier"}` : "Publier";

  return (
    <>
      {state ? (
        <span className="hidden items-center gap-2 text-sm text-[var(--muted)] lg:inline-flex" aria-live="polite">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: state.tone }} />
          {state.label}
        </span>
      ) : null}
      <Button
        type="button"
        variant="secondary"
        aria-label={buttonLabel}
        aria-haspopup="dialog"
        className="relative min-h-11 min-w-11 px-3"
        onClick={() => setOpen(true)}
      >
        <FontAwesomeIcon icon={faCloudArrowUp} className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Publier</span>
        {pending ? (
          // Sous 640 px, pastille posée sur l'icône (bouton de 44 px, comme la cloche) ; à côté du libellé au-delà.
          <span aria-hidden className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--warning)] px-1.5 text-xs font-semibold text-[var(--primary-fg)] sm:static">
            {count || "!"}
          </span>
        ) : null}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        side
        title="Publier sur kouzia.com"
        description={
          failed && !data
            ? "État de publication indisponible."
            : data?.unpublished === false
              ? data.live
                ? "kouzia.com a le contenu saisi ici."
                : "Le dépôt du site a le contenu saisi ici ; sa mise en ligne sur kouzia.com n'est pas confirmée."
              : "Les changements ci-dessous partiront ensemble : enregistrés dans le dépôt du site, puis le site est reconstruit et mis en ligne."
        }
        footer={
          <div className="flex flex-col gap-2">
            <Button type="button" className="min-h-11 w-full" disabled={Boolean(blocked) || busy} aria-busy={busy} onClick={() => void publish()}>
              <FontAwesomeIcon icon={faCloudArrowUp} className="h-4 w-4" aria-hidden />
              {busy ? "Publication…" : "Mettre en ligne"}
            </Button>
            {blocked && data ? <p className="text-sm text-[var(--muted)]">{blocked}</p> : null}
          </div>
        }
      >
        {failed && !data ? (
          <div className="flex flex-col items-start gap-3 text-sm">
            <p className="text-[var(--danger)]">Le calcul des changements a échoué.</p>
            <Button type="button" variant="secondary" onClick={() => void load()}>
              Réessayer
            </Button>
          </div>
        ) : !data ? (
          <p className="text-sm text-[var(--muted)]" aria-busy="true">
            Chargement…
          </p>
        ) : (
          <div className="flex flex-col gap-5 text-sm">
            {!data.tokenSet ? (
              <div className="flex flex-col items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--warning-soft)] p-3">
                <p className="text-[var(--warning)]">Aucun jeton GitHub : l'ERP ne peut pas publier.</p>
                <ButtonLink to="/site/connexion" variant="secondary" className="min-h-11" onClick={() => setOpen(false)}>
                  Connexion au dépôt
                </ButtonLink>
              </div>
            ) : null}

            {data.issues.length ? (
              <section aria-labelledby="publication-blocages">
                <h3 id="publication-blocages" className="font-semibold">
                  À corriger avant de publier ({data.issues.length})
                </h3>
                <ul className="mt-2 divide-y divide-[var(--border)]">
                  {data.issues.map((i) => (
                    <li key={`${i.file}:${i.path}:${i.message}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <Badge tone="red">Bloquant</Badge>
                      <span className="min-w-0 flex-1">
                        {i.message} <span className="text-[var(--muted)]">({i.path})</span>
                      </span>
                      {ISSUE_ROUTE[i.file] ? (
                        <Link to={ISSUE_ROUTE[i.file]!} className="link inline-flex min-h-11 items-center" onClick={() => setOpen(false)}>
                          Corriger
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <section aria-labelledby="publication-changements">
              <h3 id="publication-changements" className="font-semibold">
                {count ? `Changements à publier (${count})` : "Changements à publier"}
              </h3>
              {data.undetailed ? (
                <p className="mt-2 text-[var(--muted)]">
                  Le contenu diffère de la dernière publication, sans détail possible : elle date d'avant le suivi des changements. La prochaine publication rétablit le détail.
                </p>
              ) : !count ? (
                <p className="mt-2 text-[var(--muted)]">Aucun changement : kouzia.com a déjà le contenu saisi ici.</p>
              ) : (
                groups.map(([collection, items]) => (
                  <div key={collection} className="mt-3">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{GROUP[collection]}</h4>
                    <ul className="mt-1 divide-y divide-[var(--border)]">
                      {items.map((c) => (
                        <li key={`${c.collection}:${c.id}`} className="flex items-center gap-3 py-1">
                          <Badge tone={CHANGE[c.state].tone}>{CHANGE[c.state].label}</Badge>
                          <Link to={c.to} className="link inline-flex min-h-11 min-w-0 flex-1 items-center break-words" onClick={() => setOpen(false)}>
                            {c.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </section>

            {data.last ? (
              <section aria-labelledby="publication-derniere" className="rounded-[var(--radius-sm)] bg-[var(--surface-raised)] p-3" aria-live="polite">
                <h3 id="publication-derniere" className="font-semibold">
                  Dernière publication
                </h3>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge tone={PUBLICATION_STATUS[data.last.status].tone}>{PUBLICATION_STATUS[data.last.status].label}</Badge>
                </div>
                {data.last.summary ? <p className="mt-2 break-words">{data.last.summary}</p> : null}
                {data.last.error ? <p className="mt-2 text-[var(--danger)]">{data.last.error}</p> : null}
                {data.last.watching ? <p className="mt-2 text-[var(--muted)]">Suivi en direct : en ligne quand kouzia.com montre ce contenu (quelques minutes).</p> : null}
                <PublicationLinks p={data.last} />
                <ButtonLink to="/site" variant="ghost" className="mt-1 min-h-11 px-0" onClick={() => setOpen(false)}>
                  Historique des publications
                </ButtonLink>
              </section>
            ) : null}
          </div>
        )}
      </Modal>
    </>
  );
}
