import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatStrip } from "@/components/ui/StatStrip";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WithdrawalDialog, type Withdrawal } from "@/components/finance/WithdrawalDialog";

type OwnerPay = {
  availableCents: number;
  paidThisMonthCents: number;
  withdrawals: Withdrawal[];
};

/** Retraits de l'entrepreneur : virements du compte pro vers le compte perso, déduits du salaire disponible. */
export function WithdrawalsPage() {
  const [data, setData] = useState<OwnerPay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editing: Withdrawal | null } | null>(null);
  const [removing, setRemoving] = useState<Withdrawal | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<OwnerPay>("/api/owner-pay"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`/api/owner-withdrawals/${removing.id}`, { method: "DELETE" });
      toast.success("Retrait supprimé");
      setRemoving(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  const actions = (w: Withdrawal) => (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" className="px-3 text-xs" onClick={() => setDialog({ editing: w })}>
        Corriger
      </Button>
      <Button variant="ghost" className="px-3 text-xs" onClick={() => setRemoving(w)}>
        Supprimer
      </Button>
    </div>
  );

  const columns: DataColumn<Withdrawal>[] = [
    { name: "Date", selector: (w) => w.date, sortable: true, cell: (w) => formatDate(w.date) },
    {
      name: "Montant",
      selector: (w) => w.amountCents,
      sortable: true,
      right: true,
      cell: (w) => <span className="font-medium tabular-nums">{formatEUR(w.amountCents)}</span>,
    },
    { name: "Note", selector: (w) => w.note ?? "", cell: (w) => w.note ?? "", grow: 2 },
    { name: "", selector: () => "", cell: actions, right: true, width: "14rem" },
  ];

  return (
    <div>
      <PageHeader
        title="Retraits"
        subtitle="Vos virements du compte pro vers le compte perso, déduits du salaire disponible."
        actions={<Button onClick={() => setDialog({ editing: null })}>Enregistrer un retrait</Button>}
      />

      {error ? (
        <div role="alert" className="ui-card mb-6 flex flex-wrap items-center gap-3 p-4 text-sm text-[var(--danger)]">
          {error}
          <Button variant="secondary" onClick={() => void load()}>
            Réessayer
          </Button>
        </div>
      ) : null}

      <StatStrip
        className="mb-6"
        items={[
          {
            label: "Salaire disponible",
            value: formatEUR(data?.availableCents ?? 0),
            hint: "cumul depuis le début d'activité",
            tone: "success",
          },
          { label: "Retiré ce mois-ci", value: formatEUR(data?.paidThisMonthCents ?? 0) },
        ]}
      />

      <DataTable
        columns={columns}
        data={data?.withdrawals ?? []}
        pagination
        perPage={25}
        emptyTitle={data ? "Aucun retrait enregistré" : "Chargement…"}
        emptyHint="Enregistrez ici chaque virement du compte pro vers votre compte perso."
        renderMobileCard={(w) => (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium tabular-nums">{formatEUR(w.amountCents)}</p>
              <p className="text-sm text-[var(--muted)]">
                {formatDate(w.date)}
                {w.note ? ` · ${w.note}` : ""}
              </p>
            </div>
            {actions(w)}
          </div>
        )}
      />

      <WithdrawalDialog
        open={Boolean(dialog)}
        editing={dialog?.editing ?? null}
        availableCents={data?.availableCents ?? 0}
        onClose={() => setDialog(null)}
        onDone={() => void load()}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        title="Supprimer ce retrait ?"
        message={removing ? `Retrait de ${formatEUR(removing.amountCents)} du ${formatDate(removing.date)} : il ne sera plus déduit du salaire disponible.` : ""}
        confirmLabel="Supprimer"
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
