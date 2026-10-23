import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheckDouble } from "@fortawesome/free-solid-svg-icons";
import { api, formatDate } from "@/lib/api";
import { useUrlFilters } from "@/lib/use-url-filters";
import { REVIEW_CHANGED_EVENT, type ReviewItem, type ReviewQueue } from "@/lib/email-review";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Banner } from "@/components/ui/Banner";
import { StatStrip } from "@/components/ui/StatStrip";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { ReviewEmailDialog } from "@/components/messaging/ReviewEmailDialog";
import { LoadState } from "@/pages/site/shared";

type View = "a-valider" | "refuses";
/** La mise en demeure n'est jamais validée en groupe : elle se relit une par une. */
const NEVER_BULK = "formal_notice";

function StateBadge({ row }: { row: ReviewItem }) {
  if (row.status === "REJECTED") return <Badge tone="neutral">Refusé</Badge>;
  return row.clientWaiting ? <Badge tone="amber">Le client attend</Badge> : <Badge tone="blue">À valider</Badge>;
}

/**
 * « E-mails à valider » (E6) : e-mails automatiques au client en attente de validation, les plus urgents d'abord, et
 * refus des 30 derniers jours. Un e-mail s'ouvre pour être relu, validé ou refusé ; les réglages choisissent les
 * familles validées d'office.
 */
export function EmailReviewPage() {
  const filters = useUrlFilters();
  const view = filters.pick<View>("vue", ["a-valider", "refuses"], "a-valider");
  const openId = filters.text("id") || null;
  const [queue, setQueue] = useState<ReviewQueue>({ pending: [], rejected: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setQueue(await api<ReviewQueue>("/api/emails/review"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "File indisponible");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const waiting = queue.pending.filter((r) => r.clientWaiting).length;
  const bulk = queue.pending.filter((r) => r.family !== NEVER_BULK);
  const rows = view === "refuses" ? queue.rejected : queue.pending;
  const hrefOf = (r: ReviewItem) => `?${new URLSearchParams({ ...(view === "refuses" ? { vue: "refuses" } : {}), id: r.id }).toString()}`;

  async function approveAll() {
    setBusy(true);
    try {
      const { approved } = await api<{ approved: number }>("/api/emails/review/approve", { method: "POST", body: JSON.stringify({ ids: bulk.map((r) => r.id) }) });
      toast.success(approved > 1 ? `${approved} e-mails validés : ils partent avec la file d'envoi` : "E-mail validé : il part avec la file d'envoi");
      setConfirmAll(false);
      window.dispatchEvent(new Event(REVIEW_CHANGED_EVENT));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Validation impossible");
    } finally {
      setBusy(false);
    }
  }

  const columns: DataColumn<ReviewItem>[] = [
    {
      name: "E-mail",
      grow: 3,
      cell: (r) => (
        <div className="min-w-0 py-2">
          <Link to={hrefOf(r)} className="block max-w-full truncate font-medium hover:text-[var(--primary)]">
            {r.subject}
          </Link>
          <p className="truncate text-xs text-[var(--muted)]">{r.clientName ?? r.to}</p>
        </div>
      ),
    },
    { name: "Type", grow: 2, showFrom: 1024, cell: (r) => r.familyLabel ?? "E-mail automatique" },
    { name: "Origine", grow: 2, showFrom: 1280, cell: (r) => r.originLabel ?? "" },
    { name: view === "refuses" ? "Refusé le" : "Préparé le", width: "8rem", showFrom: 1024, cell: (r) => formatDate(view === "refuses" ? r.reviewedAt : r.createdAt) },
    { name: "État", width: "10rem", cell: (r) => <StateBadge row={r} /> },
  ];

  return (
    <div>
      <PageHeader
        title="E-mails à valider"
        subtitle="E-mails automatiques prêts à partir chez un client : ils attendent votre validation. Les familles validées d'office se règlent dans Réglages, E-mail."
        actions={
          view === "a-valider" && bulk.length > 1 ? (
            <Button variant="secondary" onClick={() => setConfirmAll(true)}>
              <FontAwesomeIcon icon={faCheckDouble} className="h-3.5 w-3.5" aria-hidden />
              Tout valider
            </Button>
          ) : undefined
        }
      />
      <LoadState loading={loading} error={error} onRetry={() => void load()}>
        <StatStrip
          className="mb-4"
          items={[
            { label: "À valider", value: queue.pending.length, tone: queue.pending.length ? "warning" : "default" },
            { label: "Le client attend", value: waiting, tone: waiting ? "warning" : "default" },
            { label: "Refusés (30 jours)", shortLabel: "Refusés (30 j)", value: queue.rejected.length },
          ]}
        />
        {waiting > 0 && view === "a-valider" ? (
          <Banner level="warning" className="mb-4">
            {waiting > 1 ? `${waiting} clients attendent un e-mail : ils sont en tête de liste.` : "Un client attend un e-mail : il est en tête de liste."}
          </Banner>
        ) : null}
        <Card className="overflow-hidden">
          <DataTable
            columns={columns}
            data={rows}
            onRowClick={(r) => filters.set({ id: r.id })}
            countLabel={rows.length > 1 ? "e-mails" : "e-mail"}
            emptyTitle={view === "refuses" ? "Aucun refus ces 30 derniers jours" : "Aucun e-mail à valider"}
            emptyHint={view === "refuses" ? "Les e-mails refusés restent visibles 30 jours, avec leur motif." : "Les e-mails automatiques arrivent ici avant de partir chez le client."}
            toolbar={
              <Segmented
                label="E-mails affichés"
                value={view}
                onChange={(v) => filters.set({ vue: v === "a-valider" ? null : v, id: null })}
                options={[
                  { id: "a-valider", label: "À valider", count: queue.pending.length },
                  { id: "refuses", label: "Refusés", count: queue.rejected.length },
                ]}
              />
            }
            renderMobileCard={(r) => (
              <div className="flex min-w-0 items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2.5">
                <Link to={hrefOf(r)} className="block min-h-11 min-w-0 flex-1">
                  <span className="line-clamp-2 break-words font-medium">{r.subject}</span>
                  <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">
                    {r.clientName ?? r.to}, {r.familyLabel ?? "e-mail automatique"}
                  </span>
                  <span className="mt-1 block">
                    <StateBadge row={r} />
                  </span>
                </Link>
              </div>
            )}
          />
        </Card>
      </LoadState>
      <ReviewEmailDialog id={openId} onClose={() => filters.set({ id: null })} onDone={load} />
      <ConfirmDialog
        open={confirmAll}
        title={`Valider ${bulk.length} e-mails tels quels ?`}
        message={`Ils partent avec la file d'envoi, sans relecture.${queue.pending.length > bulk.length ? " Les mises en demeure restent à valider une par une." : ""}`}
        confirmLabel="Tout valider"
        busy={busy}
        onConfirm={() => void approveAll()}
        onClose={() => setConfirmAll(false)}
      />
    </div>
  );
}
