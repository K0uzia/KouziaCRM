import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { bankStatusLabel, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Field, Input, Select } from "@/components/ui/Field";

type MatchSuggestion = {
  invoiceId: string;
  number: string | null;
  clientName: string;
  totalCents: number;
  remainingCents: number;
  deltaCents: number;
  reason: string;
};

type BankTx = {
  id: string;
  bookedAt: string;
  amountCents: number;
  counterpartyName: string | null;
  reference: string | null;
  status: "PENDING" | "MATCHED" | "UNMATCHED" | "IGNORED";
  ignoreCategory: "FRAIS_BANCAIRES" | "AUTRE" | null;
  suggestions: MatchSuggestion[] | null;
  matchedInvoice: { id: string; number: string | null } | null;
};

type BankList = {
  periodCreditCents: number;
  unmatchedCount: number;
  transactions: BankTx[];
};

type SyncLog = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  imported: number;
  updated: number;
  matchedAuto: number;
  unmatched: number;
  errorMessage: string | null;
};

type InvoiceOpt = {
  id: string;
  number: string | null;
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  clientName: string;
};

type SimResult = BankTx & {
  autoMatched: boolean;
  paymentId: string | null;
  matchMode: "invoice" | "orphan" | null;
};

function statusTone(status: BankTx["status"]): "green" | "amber" | "neutral" | "blue" {
  if (status === "MATCHED") return "green";
  if (status === "UNMATCHED") return "amber";
  if (status === "PENDING") return "blue";
  return "neutral";
}

export function BankPage() {
  const [data, setData] = useState<BankList | null>(null);
  const [fees, setFees] = useState<BankTx[]>([]);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BankTx | null>(null);
  const [suggestions, setSuggestions] = useState<MatchSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"all" | "fees" | "logs">("all");
  const [configured, setConfigured] = useState(true);

  const [simOpen, setSimOpen] = useState(false);
  const [simAmount, setSimAmount] = useState("1200");
  const [simName, setSimName] = useState("Client simulation");
  const [simInvoiceId, setSimInvoiceId] = useState("");
  const [simOrphan, setSimOrphan] = useState(true);
  const [simInvoices, setSimInvoices] = useState<InvoiceOpt[]>([]);
  const [openInvoices, setOpenInvoices] = useState<InvoiceOpt[]>([]);
  const [manualInvoiceId, setManualInvoiceId] = useState("");
  const [simBusy, setSimBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [list, feeList, syncLogs, status] = await Promise.all([
        api<BankList>("/api/bank/transactions"),
        api<BankList>("/api/bank/transactions?feesOnly=1"),
        api<SyncLog[]>("/api/bank/sync-logs"),
        api<{ configured: boolean }>("/api/bank/status"),
      ]);
      setData(list);
      setFees(feeList.transactions);
      setLogs(syncLogs);
      setConfigured(status.configured);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function loadOpenInvoices() {
    return api<InvoiceOpt[]>("/api/bank/open-invoices");
  }

  async function openSimModal() {
    setSimOpen(true);
    try {
      const open = await loadOpenInvoices();
      setSimInvoices(open);
      if (open[0] && !simInvoiceId) {
        setSimInvoiceId(open[0].id);
        setSimAmount((open[0].remainingCents / 100).toFixed(2));
        setSimName(open[0].clientName);
      }
    } catch {
      setSimInvoices([]);
    }
  }

  async function simulateTransfer() {
    setSimBusy(true);
    try {
      const res = await api<SimResult>("/api/bank/simulate", {
        method: "POST",
        body: JSON.stringify({
          amountEuros: Number(simAmount),
          counterpartyName: simName || "Client simulation",
          invoiceId: simInvoiceId || undefined,
          orphanIfUnmatched: simOrphan,
        }),
      });
      if (res.autoMatched) {
        toast.success(
          res.matchMode === "orphan"
            ? `${formatEUR(res.amountCents)} comptabilisé (encaissement sans facture)`
            : `Rapproché sur ${res.matchedInvoice?.number ?? "facture"} : visible dans l'accueil`,
        );
        setSimOpen(false);
      } else {
        toast.message(
          "Virement créé : rapprochez-le pour l'inclure dans l'encaissé du dashboard",
        );
        setSimOpen(false);
        await openMatch(res);
      }
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Échec simulation");
    } finally {
      setSimBusy(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const result = await api<{
        skipped: boolean;
        reason?: string;
        imported: number;
        matchedAuto: number;
        unmatched: number;
      }>("/api/bank/sync", { method: "POST", body: JSON.stringify({ force: true }) });
      if (result.skipped) {
        toast.message(result.reason ?? "Sync ignorée");
      } else {
        toast.success(
          `Import ${result.imported} · auto ${result.matchedAuto} · file ${result.unmatched}`,
        );
      }
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sync échouée");
    } finally {
      setSyncing(false);
    }
  }

  async function openMatch(tx: BankTx) {
    setSelected(tx);
    setManualInvoiceId("");
    setBusy(true);
    try {
      const [res, open] = await Promise.all([
        api<{ suggestions: MatchSuggestion[] }>(`/api/bank/transactions/${tx.id}/suggestions`),
        loadOpenInvoices(),
      ]);
      setSuggestions(res.suggestions);
      setOpenInvoices(open);
      const preselect =
        res.suggestions[0]?.invoiceId ?? open[0]?.id ?? "";
      setManualInvoiceId(preselect);
    } catch {
      setSuggestions(tx.suggestions ?? []);
      try {
        const open = await loadOpenInvoices();
        setOpenInvoices(open);
        setManualInvoiceId(open[0]?.id ?? "");
      } catch {
        setOpenInvoices([]);
      }
    } finally {
      setBusy(false);
    }
  }

  async function matchInvoice(invoiceId: string, allowPartial: boolean) {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/bank/transactions/${selected.id}/match`, {
        method: "POST",
        body: JSON.stringify({ invoiceId, allowPartial }),
      });
      toast.success("Rapprochement enregistré");
      setSelected(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Échec");
    } finally {
      setBusy(false);
    }
  }

  async function ignoreTx(category: "FRAIS_BANCAIRES" | "AUTRE") {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/bank/transactions/${selected.id}/ignore`, {
        method: "POST",
        body: JSON.stringify({ category }),
      });
      toast.success("Transaction ignorée");
      setSelected(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Échec");
    } finally {
      setBusy(false);
    }
  }

  async function orphanPayment() {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/bank/transactions/${selected.id}/orphan-payment`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast.success("Encaissement sans facture créé");
      setSelected(null);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Échec");
    } finally {
      setBusy(false);
    }
  }

  const unmatched = data?.unmatchedCount ?? 0;

  const manualInvoice = openInvoices.find((i) => i.id === manualInvoiceId) ?? null;
  const manualDelta =
    selected && manualInvoice
      ? selected.amountCents - manualInvoice.remainingCents
      : null;
  const manualOverpay = manualDelta !== null && manualDelta > 0;
  const manualPartial = manualDelta !== null && manualDelta < 0;

  return (
    <div>
      <PageHeader
        title="Virements reçus"
        subtitle="Ce qui est arrivé sur le compte Revolut"
        actions={
          <div className="flex flex-wrap gap-2">
            {import.meta.env.DEV ? (
              <Button type="button" variant="secondary" onClick={() => void openSimModal()}>
                Simuler un virement
              </Button>
            ) : null}
            <Button type="button" onClick={() => void syncNow()} disabled={syncing}>
              {syncing ? "Sync…" : "Synchroniser maintenant"}
            </Button>
          </div>
        }
      />

      {!configured ? (
        <Card className="mb-4 border-[var(--warning)]/40 p-4 text-sm">
          Revolut non configuré. Renseigner REVOLUT_PRIVATE_KEY, REVOLUT_CLIENT_UUID,
          REVOLUT_REFRESH_TOKEN et REVOLUT_ENV=sandbox dans .env.
        </Card>
      ) : null}

      {unmatched > 0 ? (
        <Card className="mb-4 border-[var(--warning)]/30 p-4 text-sm text-[var(--text)]">
          {unmatched} virement(s) non rapproché(s). Tant qu&apos;ils le sont, ils n&apos;apparaissent
          pas dans l&apos;encaissé du dashboard ni dans les encaissements. Cliquez une ligne pour
          rapprocher ou classer.
        </Card>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Card className="p-4">
          <p className="text-xs text-[var(--muted)]">Crédits importés (hors ignorés)</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {formatEUR(data?.periodCreditCents ?? 0)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-[var(--muted)]">Non rapprochées</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-semibold tabular-nums">
            {unmatched}
            {unmatched > 0 ? <Badge tone="amber">{unmatched}</Badge> : null}
          </p>
        </Card>
      </div>

      <div className="mb-3 flex gap-2 text-sm">
        {(
          [
            ["all", "Transactions"],
            ["fees", "Frais bancaires"],
            ["logs", "Logs sync"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-1.5 ${
              tab === id
                ? "bg-[var(--primary-soft)] text-[var(--primary)]"
                : "bg-[var(--surface-raised)] text-[var(--muted)] ring-1 ring-[var(--border)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-[var(--muted)]">Chargement…</p>
      ) : error ? (
        <p className="text-sm text-[var(--danger)]">{error}</p>
      ) : tab === "logs" ? (
        <Card>
          {logs.length === 0 ? (
            <EmptyState title="Aucun log" hint="Lancez une synchronisation." />
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--border)] text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Début</th>
                  <th className="px-4 py-3 font-medium">Import</th>
                  <th className="px-4 py-3 font-medium">Auto</th>
                  <th className="px-4 py-3 font-medium">File</th>
                  <th className="px-4 py-3 font-medium">Erreur</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3">{formatDate(l.startedAt)}</td>
                    <td className="px-4 py-3 tabular-nums">{l.imported}</td>
                    <td className="px-4 py-3 tabular-nums">{l.matchedAuto}</td>
                    <td className="px-4 py-3 tabular-nums">{l.unmatched}</td>
                    <td className="px-4 py-3 text-[var(--danger)]">
                      {l.errorMessage ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : tab === "fees" ? (
        <Card>
          {fees.length === 0 ? (
            <EmptyState
              title="Aucun frais"
              hint="Ignorez une transaction avec la catégorie Frais bancaires."
            />
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--border)] text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Libellé</th>
                  <th className="px-4 py-3 font-medium">Montant</th>
                </tr>
              </thead>
              <tbody>
                {fees.map((t) => (
                  <tr key={t.id} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3">{formatDate(t.bookedAt)}</td>
                    <td className="px-4 py-3">
                      {t.counterpartyName ?? t.reference ?? "-"}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{formatEUR(t.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : (
        <Card>
          {!data || data.transactions.length === 0 ? (
            <EmptyState
              title="Aucune transaction"
              hint="Synchronisez Revolut pour importer les virements."
            />
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--border)] text-[var(--muted)]">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Contrepartie</th>
                  <th className="px-4 py-3 font-medium">Référence</th>
                  <th className="px-4 py-3 font-medium">Montant</th>
                  <th className="px-4 py-3 font-medium">Statut</th>
                </tr>
              </thead>
              <tbody>
                {data.transactions.map((t) => (
                  <tr
                    key={t.id}
                    className={`border-t border-[var(--border)] ${
                      t.status === "UNMATCHED"
                        ? "cursor-pointer hover:bg-[var(--bg)]"
                        : ""
                    }`}
                    onClick={() => {
                      if (t.status === "UNMATCHED") void openMatch(t);
                    }}
                  >
                    <td className="px-4 py-3">{formatDate(t.bookedAt)}</td>
                    <td className="px-4 py-3">{t.counterpartyName ?? "-"}</td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-[var(--muted)]">
                      {t.reference ?? "-"}
                      {t.matchedInvoice?.number ? (
                        <>
                          {" · "}
                          <Link
                            to={`/invoices/${t.matchedInvoice.id}`}
                            className="text-[var(--primary)] hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {t.matchedInvoice.number}
                          </Link>
                        </>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-[var(--success)]">
                      {formatEUR(t.amountCents)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={statusTone(t.status)}>
                        {bankStatusLabel[t.status] ?? t.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <Modal
        open={selected !== null}
        onClose={() => !busy && setSelected(null)}
        title="Associer à une facture"
        description={
          selected
            ? `${formatEUR(selected.amountCents)} - ${selected.counterpartyName ?? "Sans contrepartie"}. Rapprochement comptable uniquement : classer sans facture ne supprime pas l'encaissement sur votre compte.`
            : undefined
        }
        wide
      >
        {selected ? (
          <div className="space-y-4">
            <p className="text-sm text-[var(--muted)]">
              Réf. : {selected.reference ?? "-"} · date valeur{" "}
              {formatDate(selected.bookedAt)}
            </p>
            {busy && suggestions.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">Chargement des suggestions…</p>
            ) : suggestions.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">
                Aucune suggestion automatique (montant ou client différent).
              </p>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                {suggestions.map((s) => {
                  const partial = s.deltaCents !== 0;
                  return (
                    <li
                      key={s.invoiceId}
                      className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm"
                    >
                      <div>
                        <p className="font-medium">
                          {s.number ?? "Sans n°"} - {s.clientName}
                        </p>
                        <p className="text-[var(--muted)]">
                          Reste {formatEUR(s.remainingCents)}
                          {partial ? (
                            <span className="text-[var(--warning)]">
                              {" "}
                              · écart {formatEUR(s.deltaCents)}
                            </span>
                          ) : null}
                          {" · "}
                          {s.reason}
                        </p>
                      </div>
                      <Button
                        type="button"
                        className="h-9 px-3 text-xs"
                        disabled={busy}
                        onClick={() => void matchInvoice(s.invoiceId, partial)}
                      >
                        {partial ? "Rapprocher (partiel)" : "Rapprocher"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-4">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text)]">
                  Rapprocher sur une facture
                </h3>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Choix manuel parmi les factures émises avec un reste à payer.
                </p>
              </div>
              {openInvoices.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">
                  Aucune facture en attente. Émettez une facture (statut émis, non soldée) ou
                  utilisez un encaissement sans facture.
                </p>
              ) : (
                <>
                  <Field label="Facture">
                    <Select
                      value={manualInvoiceId}
                      onChange={(e) => setManualInvoiceId(e.target.value)}
                    >
                      <option value="">Sélectionner…</option>
                      {openInvoices.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.number ?? "Sans n°"} · {i.clientName} · reste{" "}
                          {formatEUR(i.remainingCents)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {manualInvoice && selected ? (
                    <p className="text-xs text-[var(--muted)]">
                      Virement {formatEUR(selected.amountCents)} · reste facture{" "}
                      {formatEUR(manualInvoice.remainingCents)}
                      {manualOverpay ? (
                        <span className="text-[var(--danger)]">
                          {" "}
                          · le virement dépasse le reste dû de {formatEUR(manualDelta!)}
                        </span>
                      ) : null}
                      {manualPartial ? (
                        <span className="text-[var(--warning)]">
                          {" "}
                          · paiement partiel ({formatEUR(-manualDelta!)} resteront dus)
                        </span>
                      ) : null}
                    </p>
                  ) : null}
                  <Button
                    type="button"
                    disabled={busy || !manualInvoiceId || manualOverpay}
                    onClick={() => void matchInvoice(manualInvoiceId, manualPartial)}
                  >
                    {manualPartial ? "Rapprocher (partiel)" : "Rapprocher sur cette facture"}
                  </Button>
                </>
              )}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void ignoreTx("FRAIS_BANCAIRES")}
              >
                Classer : frais bancaires
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void ignoreTx("AUTRE")}
              >
                Classer : autre (sans facture)
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void orphanPayment()}
              >
                Créer un encaissement sans facture
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={simOpen}
        onClose={() => !simBusy && setSimOpen(false)}
        title="Simuler un virement reçu"
        description="En développement uniquement. Le montant entre dans l'encaissé après rapprochement (facture) ou si l'option ci-dessous est cochée."
      >
        <div className="space-y-4">
          <Field label="Montant (€)">
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={simAmount}
              onChange={(e) => setSimAmount(e.target.value)}
            />
          </Field>
          <Field label="Émetteur">
            <Input value={simName} onChange={(e) => setSimName(e.target.value)} />
          </Field>
          <Field label="Facture (optionnel)">
            <Select
              value={simInvoiceId}
              onChange={(e) => {
                const id = e.target.value;
                setSimInvoiceId(id);
                const inv = simInvoices.find((i) => i.id === id);
                if (inv) {
                  setSimAmount((inv.remainingCents / 100).toFixed(2));
                  setSimName(inv.clientName);
                }
              }}
            >
              <option value="">Rapprochement auto ou manuel ensuite</option>
              {simInvoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.number ?? "Brouillon"} · {i.clientName} · reste{" "}
                  {formatEUR(i.remainingCents)}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={simOrphan}
              onChange={(e) => setSimOrphan(e.target.checked)}
              disabled={Boolean(simInvoiceId)}
            />
            <span>
              Comptabiliser dans l&apos;encaissé si aucune facture ne correspond (encaissement sans
              facture)
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setSimOpen(false)}>
              Annuler
            </Button>
            <Button type="button" disabled={simBusy} onClick={() => void simulateTransfer()}>
              {simBusy ? "…" : "Créer"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
