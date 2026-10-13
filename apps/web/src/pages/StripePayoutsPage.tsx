import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircleCheck, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { api, formatEUR } from "@/lib/api";
import { formatDate, paymentMethodLabel } from "@/lib/format";
import { useLiveRefresh } from "@/lib/notifications";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Field, Select } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { StatStrip } from "@/components/ui/StatStrip";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";

type FluxPayment = {
  id: string;
  amountCents: number;
  feeCents: number | null;
  paidAt: string;
  method: string;
  invoice: { id: string; number: string | null; client: { displayName: string } } | null;
};

type FluxPayout = {
  id: string;
  stripePayoutId: string;
  amountCents: number;
  arrivalDate: string | null;
  status: string;
  grossCents: number;
  feeCents: number;
  deductionsCents: number;
  expectedCents: number;
  gapCents: number | null;
  payments: FluxPayment[];
};

export type FluxMonth = {
  key: string;
  label: string;
  caCents: number;
  encaisseStripeCents: number;
  directCents: number;
  feeCents: number;
  unknownFeeCount: number;
  refundsDisputesCents: number;
  verseCents: number;
  pendingCents: number;
  gapCents: number;
};

type Flux = { months: string[]; month: FluxMonth; payouts: FluxPayout[]; series: FluxMonth[] };

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "neutral" }> = {
  paid: { label: "Arrivé", tone: "green" },
  in_transit: { label: "En cours", tone: "amber" },
  pending: { label: "Prévu", tone: "amber" },
  failed: { label: "Échec", tone: "red" },
  canceled: { label: "Annulé", tone: "neutral" },
};

const monthName = (key: string) => {
  const [y, m] = key.split("-").map(Number) as [number, number];
  const s = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(new Date(y, m - 1, 1));
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Correspondance d'un versement : brut − frais − retenues = viré, ou l'écart, jamais masqué. */
function Match({ p }: { p: FluxPayout }) {
  if (p.gapCents === null) return <span className="text-[var(--muted)]">vérifié à l&apos;arrivée</span>;
  if (p.gapCents === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[var(--success)]">
        <FontAwesomeIcon icon={faCircleCheck} className="h-3.5 w-3.5" aria-hidden />
        Correspond
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 font-medium text-[var(--warning)]">
      <FontAwesomeIcon icon={faTriangleExclamation} className="h-3.5 w-3.5" aria-hidden />
      Écart de {formatEUR(Math.abs(p.gapCents))}
    </span>
  );
}

function Row({ label, value, strong }: { label: ReactNode; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className={strong ? "font-medium text-[var(--text)]" : "text-[var(--muted)]"}>{label}</dt>
      <dd className={`shrink-0 text-right tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</dd>
    </div>
  );
}

/** Flux Stripe : où va chaque euro encaissé (frais, compte pro, encore chez Stripe), mois par mois. */
export function StripePayoutsPage() {
  const [data, setData] = useState<Flux | null>(null);
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ title: string; payments: FluxPayment[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Flux>(`/api/stripe/flux${month ? `?month=${month}` : ""}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), (i) => i.kind === "payment");

  const m = data?.month;
  const openPayout = (p: FluxPayout) =>
    setDetail({
      title: `Versement ${p.arrivalDate ? `du ${formatDate(p.arrivalDate)}` : "à venir"} : ${formatEUR(p.amountCents)}`,
      payments: p.payments,
    });
  const formula = (p: FluxPayout) =>
    `${p.payments.length} paiement${p.payments.length > 1 ? "s" : ""} : ${formatEUR(p.grossCents)} − frais ${formatEUR(p.feeCents)}${
      p.deductionsCents ? ` − retenues ${formatEUR(p.deductionsCents)}` : ""
    } = ${formatEUR(p.expectedCents)}`;

  const columns: DataColumn<FluxPayout>[] = [
    {
      name: "Arrivée",
      selector: (p) => p.arrivalDate ?? "",
      sortable: true,
      cell: (p) => (p.arrivalDate ? formatDate(p.arrivalDate) : "Date à venir"),
    },
    {
      name: "Viré",
      selector: (p) => p.amountCents,
      right: true,
      cell: (p) => <span className="font-medium tabular-nums">{formatEUR(p.amountCents)}</span>,
    },
    { name: "Attendu", selector: (p) => p.expectedCents, right: true, cell: (p) => formatEUR(p.expectedCents), showFrom: 1024 },
    { name: "Correspondance", selector: (p) => p.gapCents ?? 0, cell: (p) => <Match p={p} />, grow: 2 },
    {
      name: "État",
      selector: (p) => p.status,
      cell: (p) => <Badge tone={STATUS[p.status]?.tone ?? "neutral"}>{STATUS[p.status]?.label ?? p.status}</Badge>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Flux Stripe"
        subtitle="Où va chaque euro encaissé : frais Stripe, compte pro, encore chez Stripe."
        actions={
          data ? (
            <Field label="Mois">
              <Select value={m?.key ?? ""} onChange={(e) => setMonth(e.target.value)}>
                {data.months.map((k) => (
                  <option key={k} value={k}>
                    {monthName(k)}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null
        }
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
          { label: "Encaissé par Stripe", shortLabel: "Stripe", value: formatEUR(m?.encaisseStripeCents ?? 0), tone: "primary" },
          { label: "Versé au compte pro", shortLabel: "Versé", value: formatEUR(m?.verseCents ?? 0), tone: "success" },
          { label: "Encore chez Stripe", shortLabel: "En attente", value: formatEUR(m?.pendingCents ?? 0) },
          {
            label: "Écart des versements",
            shortLabel: "Écart",
            value: formatEUR(Math.abs(m?.gapCents ?? 0)),
            tone: m && m.gapCents !== 0 ? "warning" : "default",
            hint: m && m.gapCents !== 0 ? "à vérifier dans Stripe" : "tout est rapproché",
          },
        ]}
      />

      {m ? (
        <Card className="mb-6 p-5 text-sm sm:p-6">
          <h2 className="text-base font-semibold">Rapprochement de {m.label}</h2>
          <dl className="mt-3 divide-y divide-[var(--border)]">
            <Row label="Encaissé par Stripe (carte, prélèvement)" value={formatEUR(m.encaisseStripeCents)} strong />
            <Row
              label={
                <>
                  − Frais Stripe
                  {m.unknownFeeCount ? (
                    <span className="block text-xs text-[var(--warning)]">
                      frais pas encore connus pour {m.unknownFeeCount} paiement{m.unknownFeeCount > 1 ? "s" : ""}
                    </span>
                  ) : null}
                </>
              }
              value={`− ${formatEUR(m.feeCents)}`}
            />
            <Row label="− Versé sur le compte pro" value={`− ${formatEUR(m.verseCents)}`} />
            <Row label="− Encore chez Stripe, en attente" value={`− ${formatEUR(m.pendingCents)}`} />
            <Row label="− Remboursements et litiges" value={`− ${formatEUR(m.refundsDisputesCents)}`} />
            <Row
              label="= Écart des versements"
              strong
              value={
                m.gapCents === 0 ? (
                  <span className="inline-flex items-center gap-1.5 text-[var(--success)]">
                    <FontAwesomeIcon icon={faCircleCheck} className="h-3.5 w-3.5" aria-hidden />
                    0,00 € · tout est rapproché
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[var(--warning)]">
                    <FontAwesomeIcon icon={faTriangleExclamation} className="h-3.5 w-3.5" aria-hidden />
                    {formatEUR(Math.abs(m.gapCents))} à vérifier dans Stripe
                  </span>
                )
              }
            />
          </dl>
          <dl className="mt-4 divide-y divide-[var(--border)] border-t border-[var(--border)]">
            <Row label="Arrivé directement sur le compte pro (virement)" value={formatEUR(m.directCents)} />
            <Row label="CA encaissé du mois" strong value={formatEUR(m.caCents)} />
          </dl>
          <p className="mt-2 text-xs text-[var(--muted)]">
            {formatEUR(m.encaisseStripeCents)} par Stripe + {formatEUR(m.directCents)} en direct : le même chiffre que
            le tableau de bord.
          </p>
        </Card>
      ) : null}

      <h2 className="mb-3 text-sm font-semibold">Versements du mois</h2>
      <DataTable
        columns={columns}
        data={data?.payouts ?? []}
        emptyTitle={data ? "Aucun versement ce mois-ci" : "Chargement…"}
        emptyHint="Stripe vire les encaissements sur le compte pro, en général quelques jours après le paiement."
        onRowClick={openPayout}
        renderMobileCard={(p) => (
          <button
            type="button"
            onClick={() => openPayout(p)}
            className="flex w-full flex-col gap-1.5 text-left"
            aria-label={`Détail du versement de ${formatEUR(p.amountCents)}`}
          >
            <span className="flex w-full items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block font-medium tabular-nums">Viré : {formatEUR(p.amountCents)}</span>
                <span className="block text-sm text-[var(--muted)]">
                  {p.arrivalDate ? formatDate(p.arrivalDate) : "Date à venir"}
                </span>
              </span>
              <Badge tone={STATUS[p.status]?.tone ?? "neutral"}>{STATUS[p.status]?.label ?? p.status}</Badge>
            </span>
            <span className="text-sm text-[var(--muted)]">{formula(p)}</span>
            <span className="text-sm">
              <Match p={p} />
            </span>
          </button>
        )}
      />

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title={detail?.title ?? ""}>
        {detail?.payments.length ? (
          <ul className="divide-y divide-[var(--border)]">
            {detail.payments.map((pay) => (
              <li key={pay.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  {pay.invoice ? (
                    <Link to={`/invoices/${pay.invoice.id}`} className="link inline-flex min-h-11 items-center font-medium">
                      {pay.invoice.number ?? "Facture"}
                    </Link>
                  ) : (
                    <span className="font-medium">Paiement</span>
                  )}
                  <p className="truncate text-[var(--muted)]">
                    {pay.invoice?.client.displayName ?? ""} · {formatDate(pay.paidAt)} ·{" "}
                    {paymentMethodLabel[pay.method] ?? pay.method}
                  </p>
                </div>
                <div className="shrink-0 text-right tabular-nums">
                  <p className="font-medium">{formatEUR(pay.amountCents)}</p>
                  {pay.feeCents ? <p className="text-xs text-[var(--muted)]">frais {formatEUR(pay.feeCents)}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--muted)]">Aucun paiement rattaché pour l&apos;instant.</p>
        )}
      </Modal>
    </div>
  );
}
