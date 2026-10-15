import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Modal, ModalActions } from "@/components/ui/Modal";

type Decl = {
  id: string;
  periodKey: string;
  amountDueCents: number;
  encaisseCents: number;
  status: string;
  deadline: string;
  paidAt: string | null;
  paymentRef: string | null;
};

type Echeance = {
  status: "paid" | "due" | "late" | "clear";
  periodKey: string;
  periodLabel: string;
  deadline: string;
  encaisseCents: number;
  amountDueCents: number;
  paidAt: string | null;
  /** Période en cours, pas encore déclarable : encaissé à ce jour et cotisations estimées. */
  enCours?: {
    periodKey: string;
    periodLabel: string;
    deadline: string;
    encaisseCents: number;
    estimatedDueCents: number;
  };
};

const declStatusLabel: Record<string, string> = {
  DUE: "À payer",
  PAID: "Payée",
  LATE: "En retard",
};

export function UrssafPage() {
  const [rows, setRows] = useState<Decl[]>([]);
  const [echeance, setEcheance] = useState<Echeance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markOpen, setMarkOpen] = useState(false);
  const [paymentRef, setPaymentRef] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [decls, dashboard] = await Promise.all([
      api<Decl[]>("/api/urssaf/declarations"),
      api<{ echeance: Echeance }>("/api/dashboard"),
    ]);
    setRows(decls);
    setEcheance(dashboard.echeance);
    setError(null);
  }

  useEffect(() => {
    load()
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function markPaid() {
    setBusy(true);
    try {
      await api("/api/urssaf/mark-paid", {
        method: "POST",
        body: JSON.stringify({
          periodKey: echeance?.periodKey,
          paymentRef: paymentRef.trim() || undefined,
        }),
      });
      toast.success("Échéance enregistrée comme payée");
      setMarkOpen(false);
      setPaymentRef("");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  const settled = echeance?.status === "paid" || echeance?.status === "clear";

  return (
    <div className="space-y-5">
      <PageHeader
        title="URSSAF"
        subtitle="Déclarations de chiffre d'affaires et cotisations sociales, période par période."
      />

      {echeance ? (
        <Card className={`overflow-hidden ${echeance.status === "late" ? "border-[var(--danger)]/50" : ""}`}>
          <div className="flex flex-col gap-3 border-b border-[var(--border)] p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Échéance en cours</p>
              <h2 className="mt-1 text-lg font-semibold first-letter:uppercase">{echeance.periodLabel}</h2>
            </div>
            {!settled ? (
              <Button onClick={() => setMarkOpen(true)}>Marquer comme payée</Button>
            ) : (
              <Badge tone="green">{echeance.status === "paid" ? `Réglée le ${formatDate(echeance.paidAt)}` : "Rien à payer"}</Badge>
            )}
          </div>
          <dl className="grid grid-cols-1 gap-px bg-[var(--border)] sm:grid-cols-3">
            <div className="bg-[var(--surface)] p-5">
              <dt className="text-xs text-[var(--muted)]">Chiffre d'affaires encaissé</dt>
              <dd className="mt-1 font-display text-xl font-semibold tabular-nums">{formatEUR(echeance.encaisseCents)}</dd>
            </div>
            <div className="bg-[var(--surface)] p-5">
              <dt className="text-xs text-[var(--muted)]">Cotisations à payer</dt>
              <dd className="mt-1 font-display text-xl font-semibold tabular-nums text-[var(--primary)]">
                {formatEUR(echeance.amountDueCents)}
              </dd>
            </div>
            <div className="bg-[var(--surface)] p-5">
              <dt className="text-xs text-[var(--muted)]">À déclarer avant le</dt>
              <dd className={`mt-1 font-display text-xl font-semibold ${echeance.status === "late" ? "text-[var(--danger)]" : ""}`}>
                {formatDate(echeance.deadline)}
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}

      {echeance?.enCours ? (
        <Card className="overflow-hidden">
          <div className="border-b border-[var(--border)] p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">Période en cours</p>
            <h2 className="mt-1 text-lg font-semibold first-letter:uppercase">{echeance.enCours.periodLabel}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Encaissements à ce jour : ils seront déclarés à la fin de la période. Le montant dû est une estimation,
              provisionnée au tableau de bord.
            </p>
          </div>
          <dl className="grid grid-cols-1 gap-px bg-[var(--border)] sm:grid-cols-3">
            <div className="bg-[var(--surface)] p-5">
              <dt className="text-xs text-[var(--muted)]">Encaissé à ce jour</dt>
              <dd className="mt-1 font-display text-xl font-semibold tabular-nums">{formatEUR(echeance.enCours.encaisseCents)}</dd>
            </div>
            <div className="bg-[var(--surface)] p-5">
              <dt className="text-xs text-[var(--muted)]">Cotisations estimées</dt>
              <dd className="mt-1 font-display text-xl font-semibold tabular-nums text-[var(--primary)]">
                {formatEUR(echeance.enCours.estimatedDueCents)}
              </dd>
            </div>
            <div className="bg-[var(--surface)] p-5">
              <dt className="text-xs text-[var(--muted)]">À déclarer avant le</dt>
              <dd className="mt-1 font-display text-xl font-semibold">{formatDate(echeance.enCours.deadline)}</dd>
            </div>
          </dl>
        </Card>
      ) : null}

      <h2 className="pt-2 text-sm font-semibold">Historique des déclarations</h2>
      <Card>
        {loading ? (
          <p className="p-4 text-sm text-[var(--muted)]">Chargement…</p>
        ) : error ? (
          <p className="p-4 text-sm text-[var(--danger)]">{error}</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="Aucune déclaration enregistrée"
            hint="Elles apparaissent ici dès que vous marquez une échéance comme payée."
          />
        ) : (
          <div className="ui-table-wrap max-md:overflow-visible">
            <table className="ui-table ui-table-stack">
              <thead>
                <tr>
                  <th className="nowrap">Période</th>
                  <th className="nowrap">Encaissé</th>
                  <th className="nowrap">Dû</th>
                  <th className="nowrap">Statut</th>
                  <th className="nowrap">Échéance</th>
                  <th className="nowrap">Référence</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap font-medium" data-label="Période">{r.periodKey}</td>
                    <td className="nowrap tabular-nums" data-label="Encaissé">{formatEUR(r.encaisseCents)}</td>
                    <td className="nowrap tabular-nums" data-label="Dû">{formatEUR(r.amountDueCents)}</td>
                    <td className="nowrap" data-label="Statut">
                      <Badge tone={r.status === "PAID" ? "green" : "amber"}>
                        {declStatusLabel[r.status] ?? r.status}
                      </Badge>
                    </td>
                    <td className="nowrap" data-label="Échéance">{formatDate(r.deadline)}</td>
                    <td className="nowrap text-[var(--muted)]" data-label="Référence">{r.paymentRef ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={markOpen}
        onClose={() => !busy && setMarkOpen(false)}
        title="Marquer l'échéance comme payée"
        description={
          echeance
            ? `${echeance.periodLabel} : ${formatEUR(echeance.amountDueCents)}`
            : undefined
        }
      >
        <div className="space-y-4">
          <Field label="Référence de paiement (facultative)">
            <Input
              value={paymentRef}
              onChange={(e) => setPaymentRef(e.target.value)}
              placeholder="Numéro de télépaiement, référence de virement…"
            />
          </Field>
          <ModalActions>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setMarkOpen(false)}
            >
              Annuler
            </Button>
            <Button type="button" disabled={busy} onClick={() => void markPaid()}>
              {busy ? "…" : "Enregistrer"}
            </Button>
          </ModalActions>
        </div>
      </Modal>
    </div>
  );
}

/** @deprecated utiliser UrssafPage */
