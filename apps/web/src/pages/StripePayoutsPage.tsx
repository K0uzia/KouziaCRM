import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatEUR } from "@/lib/api";
import { formatDate, paymentMethodLabel } from "@/lib/format";
import { useLiveRefresh } from "@/lib/notifications";
import { Badge, PageHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { StatStrip } from "@/components/ui/StatStrip";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";

type PayoutPayment = {
  id: string;
  amountCents: number;
  feeCents: number | null;
  paidAt: string;
  method: string;
  invoice: { id: string; number: string | null; client: { displayName: string } } | null;
};

type Payout = {
  id: string;
  stripePayoutId: string;
  amountCents: number;
  arrivalDate: string | null;
  status: string;
  grossCents: number;
  feeCents: number;
  payments: PayoutPayment[];
};

type Data = {
  payouts: Payout[];
  pending: { grossCents: number; feeCents: number; payments: PayoutPayment[] };
};

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "neutral" }> = {
  paid: { label: "Arrivé", tone: "green" },
  in_transit: { label: "En cours", tone: "amber" },
  pending: { label: "Prévu", tone: "amber" },
  failed: { label: "Échec", tone: "red" },
  canceled: { label: "Annulé", tone: "neutral" },
};

/** Versements de Stripe vers le compte bancaire, et les paiements clients qu'ils regroupent. */
export function StripePayoutsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ title: string; payments: PayoutPayment[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Data>("/api/stripe/payouts"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useLiveRefresh(() => void load(), (i) => i.kind === "payment");

  const columns: DataColumn<Payout>[] = [
    {
      name: "Arrivée",
      selector: (p) => p.arrivalDate ?? "",
      sortable: true,
      cell: (p) => (p.arrivalDate ? formatDate(p.arrivalDate) : "Date à venir"),
    },
    {
      name: "Versé",
      selector: (p) => p.amountCents,
      sortable: true,
      right: true,
      cell: (p) => <span className="font-medium tabular-nums">{formatEUR(p.amountCents)}</span>,
    },
    { name: "Encaissé", selector: (p) => p.grossCents, right: true, cell: (p) => formatEUR(p.grossCents) },
    { name: "Frais Stripe", selector: (p) => p.feeCents, right: true, cell: (p) => formatEUR(p.feeCents) },
    { name: "Paiements", selector: (p) => p.payments.length, right: true, showFrom: 1280 },
    {
      name: "État",
      selector: (p) => p.status,
      cell: (p) => <Badge tone={STATUS[p.status]?.tone ?? "neutral"}>{STATUS[p.status]?.label ?? p.status}</Badge>,
    },
  ];

  const openPayout = (p: Payout) =>
    setDetail({
      title: `Versement ${p.arrivalDate ? `du ${formatDate(p.arrivalDate)}` : "à venir"} : ${formatEUR(p.amountCents)}`,
      payments: p.payments,
    });

  const totalPaid = data?.payouts.filter((p) => p.status === "paid").reduce((s, p) => s + p.amountCents, 0) ?? 0;
  const totalFees = data?.payouts.reduce((s, p) => s + p.feeCents, 0) ?? 0;

  return (
    <div>
      <PageHeader title="Versements Stripe" subtitle="Ce que Stripe a viré sur votre compte bancaire" />

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
          { label: "Versé sur le compte", value: formatEUR(totalPaid), tone: "success" },
          { label: "Frais Stripe", value: formatEUR(totalFees) },
          {
            label: "À verser",
            value: formatEUR(data?.pending.grossCents ?? 0),
            hint: data?.pending.payments.length ? `${data.pending.payments.length} paiement(s)` : "rien en attente",
            tone: data?.pending.payments.length ? "primary" : "default",
          },
        ]}
      />

      {data && data.pending.payments.length > 0 ? (
        <p className="mb-4">
          <Button
            variant="secondary"
            onClick={() => setDetail({ title: "Paiements en attente de versement", payments: data.pending.payments })}
          >
            Voir les paiements en attente
          </Button>
        </p>
      ) : null}

      <DataTable
        columns={columns}
        data={data?.payouts ?? []}
        pagination
        perPage={25}
        emptyTitle={data ? "Aucun versement" : "Chargement…"}
        emptyHint="Les versements apparaissent ici quand Stripe vire vos encaissements sur votre compte."
        onRowClick={openPayout}
        renderMobileCard={(p) => (
          // Les cartes mobiles n'héritent pas du clic de ligne : la carte est elle-même un bouton.
          <button
            type="button"
            onClick={() => openPayout(p)}
            className="flex w-full items-start justify-between gap-3 text-left"
            aria-label={`Détail du versement de ${formatEUR(p.amountCents)}`}
          >
            <div className="min-w-0">
              <p className="font-medium tabular-nums">{formatEUR(p.amountCents)}</p>
              <p className="text-sm text-[var(--muted)]">
                {p.arrivalDate ? formatDate(p.arrivalDate) : "Date à venir"} · {p.payments.length} paiement(s) · frais{" "}
                {formatEUR(p.feeCents)}
              </p>
            </div>
            <span className="shrink-0 whitespace-nowrap">
              <Badge tone={STATUS[p.status]?.tone ?? "neutral"}>{STATUS[p.status]?.label ?? p.status}</Badge>
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
