import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDate, formatTime } from "@/lib/format";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { LoadState, useSiteCollection } from "./shared";
import { PUBLICATION_STATUS, PublicationLinks, type SitePublication } from "./SitePublicationCard";

type Kind = "added" | "removed" | "modified" | "order";
type Entry = {
  file: string;
  key: string;
  label: string;
  kind: Kind;
  fields: Array<{ name: string; before: string | null; after: string | null }>;
  restore: Array<{ side: Side; current: "same" | "different" | "absent" }>;
};
type Side = "after" | "before";
type Detail = { available: boolean; first: boolean; entries: Entry[] };
type Restored = { label: string; to: string; created: boolean; missingMedia: string[] };

const KIND: Record<Kind, { label: string; tone: "green" | "blue" | "red" | "neutral" }> = {
  added: { label: "Ajouté", tone: "green" },
  modified: { label: "Modifié", tone: "blue" },
  removed: { label: "Retiré", tone: "red" },
  order: { label: "Ordre", tone: "neutral" },
};
const FILE_LABEL: Record<string, string> = {
  realisations: "Réalisations",
  avis: "Témoignages",
  references: "Références",
  faq: "FAQ",
  textes: "Accroche et offres",
  infos: "Coordonnées",
};
/** Ce à quoi la fiche actuelle correspond, d'après les versions restaurables de l'entrée. */
function currentText(e: Entry): string | null {
  if (!e.restore.length) return null;
  if (e.restore.some((o) => o.current === "absent")) return "Plus dans l'ERP : restaurer la recrée en brouillon.";
  const same = e.restore.find((o) => o.current === "same");
  if (!same) return "La fiche actuelle a changé depuis.";
  return e.kind === "modified" ? `Fiche actuelle identique à la version ${same.side === "before" ? "d'avant" : "publiée ici"}.` : "Fiche actuelle identique à cette version.";
}
const restoreLabel = (e: Entry, side: Side) =>
  side === "after" ? "Restaurer cette version" : e.kind === "removed" ? "Restaurer la version retirée" : "Restaurer la version d'avant";
const when = (iso: string) => `${formatDate(iso)} à ${formatTime(iso)}`;

/**
 * Historique des publications de kouzia.com : ce que chacune a changé, et restauration d'une version dans l'ERP
 * (la fiche reprend le contenu publié ce jour-là ; rien ne change en ligne avant « Publier »).
 */
export function SiteHistoryPage() {
  const { rows, loading, error, reload } = useSiteCollection<SitePublication>("/api/site/publications");
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = rows.find((p) => p.id === openId) ?? null;

  return (
    <div>
      <PageHeader
        title="Historique"
        subtitle="Les 20 dernières publications de kouzia.com et ce qu'elles ont changé. Une version passée peut être remise dans sa fiche : elle part en ligne seulement avec « Publier »."
      />
      <LoadState loading={loading} error={error} onRetry={() => void reload()}>
        {rows.length ? (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-[var(--border)]">
              {rows.map((p) => (
                <li key={p.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        aria-haspopup="dialog"
                        data-publication-id={p.id}
                        onClick={() => setOpenId(p.id)}
                        className="inline-flex min-h-11 items-center text-left font-medium hover:text-[var(--primary)]"
                      >
                        {when(p.startedAt)}
                      </button>
                      <Badge tone={PUBLICATION_STATUS[p.status].tone}>{PUBLICATION_STATUS[p.status].label}</Badge>
                    </p>
                    <p className="text-sm text-[var(--muted)]">{p.error ?? p.summary}</p>
                  </div>
                  <PublicationLinks p={p} />
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <Card className="p-6 text-center">
            <p className="font-medium">Aucune publication pour l'instant</p>
            <p className="mt-1 text-sm text-[var(--muted)]">Elles apparaissent ici après chaque « Publier », avec ce qu'elles ont changé.</p>
          </Card>
        )}
      </LoadState>
      {opened ? (
        <PublicationPanel
          key={opened.id}
          publication={opened}
          onClose={() => {
            const id = opened.id;
            setOpenId(null);
            requestAnimationFrame(() => {
              if (document.activeElement === document.body) document.querySelector<HTMLElement>(`[data-publication-id="${id}"]`)?.focus();
            });
          }}
        />
      ) : null}
    </div>
  );
}

function PublicationPanel({ publication, onClose }: { publication: SitePublication; onClose: () => void }) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ entry: Entry; side: Side } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api<Detail>(`/api/site/publications/${publication.id}/detail`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, [publication.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function restore(entry: Entry, side: Side) {
    setBusy(true);
    try {
      const r = await api<Restored>(`/api/site/publications/${publication.id}/restore`, {
        method: "POST",
        body: JSON.stringify({ file: entry.file, key: entry.key, side }),
      });
      setConfirm(null);
      toast.success(`${r.label} : version restaurée${r.created ? " (recréée en brouillon)" : ""}. À publier pour la mettre en ligne.`, {
        action: { label: "Ouvrir", onClick: () => navigate(r.to) },
      });
      if (r.missingMedia.length) toast.warning(`Image absente de l'ERP (${r.missingMedia.join(", ")}) : la renvoyer depuis la fiche avant de publier.`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Restauration impossible");
    } finally {
      setBusy(false);
    }
  }

  // Regroupement par fichier, dans l'ordre où l'API les donne (Object.groupBy : trop récent pour la cible).
  const groups: Array<[string, Entry[]]> = [];
  for (const e of detail?.entries ?? []) {
    const g = groups.find(([file]) => file === e.file);
    if (g) g[1].push(e);
    else groups.push([e.file, [e]]);
  }

  return (
    <Modal open side onClose={onClose} title={`Publication du ${when(publication.startedAt)}`} description={publication.error ?? publication.summary}>
      <div className="space-y-5 text-sm">
        <PublicationLinks p={publication} />
        {error ? (
          <div className="flex flex-col items-start gap-3" role="alert">
            <p className="text-[var(--danger)]">{error}</p>
            <Button variant="secondary" onClick={() => void load()}>
              Réessayer
            </Button>
          </div>
        ) : !detail ? (
          <p className="text-[var(--muted)]" role="status">
            Chargement…
          </p>
        ) : !detail.available ? (
          <p className="text-[var(--muted)]">
            Détail non conservé : publication antérieure au suivi des changements, ou au-delà des 50 dernières.
          </p>
        ) : !detail.entries.length ? (
          <p className="text-[var(--muted)]">Aucun changement : kouzia.com avait déjà ce contenu.</p>
        ) : (
          <>
            {detail.first ? <p className="text-[var(--muted)]">Première publication suivie : tout le contenu publié ce jour-là.</p> : null}
            {groups.map(([file, entries]) => (
              <section key={file} aria-labelledby={`hist-${file}`}>
                <h3 id={`hist-${file}`} className="font-semibold">
                  {FILE_LABEL[file] ?? file}
                </h3>
                <ul className="mt-2 divide-y divide-[var(--border)] rounded-[var(--radius)] border border-[var(--border)]">
                  {entries.map((e) => (
                    <li key={`${e.kind}:${e.key}`} className="space-y-2 p-3">
                      <p className="flex flex-wrap items-center gap-2">
                        <Badge tone={KIND[e.kind].tone}>{KIND[e.kind].label}</Badge>
                        <span className="min-w-0 break-words font-medium">{e.label}</span>
                      </p>
                      {e.fields.length ? (
                        <details className="group">
                          <summary className="inline-flex min-h-11 cursor-pointer items-center text-[var(--muted)] hover:text-[var(--text)]">
                            {e.fields.length > 1 ? `${e.fields.length} champs` : "1 champ"}
                          </summary>
                          <dl className="mt-1 space-y-2">
                            {e.fields.map((f) => (
                              <div key={f.name} className="min-w-0">
                                <dt className="font-medium">{f.name}</dt>
                                {f.before !== null ? (
                                  <dd className="break-words text-[var(--muted)]">
                                    Avant : <del>{f.before}</del>
                                  </dd>
                                ) : null}
                                {f.after !== null ? (
                                  <dd className="break-words">
                                    Après : <ins className="no-underline">{f.after}</ins>
                                  </dd>
                                ) : null}
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : null}
                      {currentText(e) ? <p className="text-xs text-[var(--muted)]">{currentText(e)}</p> : null}
                      {e.restore.some((o) => o.current !== "same") ? (
                        <div className="flex flex-wrap gap-2">
                          {e.restore
                            .filter((o) => o.current !== "same")
                            .map((o) => (
                              <Button key={o.side} variant="secondary" disabled={busy} onClick={() => setConfirm({ entry: e, side: o.side })}>
                                {restoreLabel(e, o.side)}
                              </Button>
                            ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
      <ConfirmDialog
        open={Boolean(confirm)}
        busy={busy}
        title="Restaurer cette version ?"
        message={
          confirm
            ? `« ${confirm.entry.label} » reprend le contenu ${confirm.side === "before" ? "d'avant cette publication" : `publié le ${when(publication.startedAt)}`} : la fiche actuelle est remplacée${confirm.entry.restore.some((o) => o.current === "absent") ? " (recréée en brouillon)" : ""}. Rien ne change sur kouzia.com avant « Publier ».`
            : ""
        }
        confirmLabel="Restaurer"
        onConfirm={() => confirm && void restore(confirm.entry, confirm.side)}
        onClose={() => setConfirm(null)}
      />
    </Modal>
  );
}
