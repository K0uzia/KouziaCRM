import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useLiveRefresh } from "@/lib/notifications";
import { api, formatEUR } from "@/lib/api";
import { formatDate, paymentMethodLabel } from "@/lib/format";
import { Badge, PageHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { StatStrip } from "@/components/ui/StatStrip";
import { DataTable, type DataColumn } from "@/components/ui/DataTable";
import { ListRow } from "@/components/ui/ListRow";
import { DocumentNumberBadge } from "@/components/documents/DocumentNumberBadge";
import { PaymentForm } from "@/components/payments/PaymentForm";
import { Field, Select } from "@/components/ui/Field";
import { useCreateParam } from "@/lib/use-create-param";
import { OFFLINE_MESSAGE, useOnline } from "@/lib/network";

type Payment = {
  id: string;
  amountCents: number;
  paidAt: string;
  method: string;
  reference: string | null;
  feeCents: number | null;
  stripePaymentIntentId: string | null;
  invoice: {
    id: string;
    number: string | null;
    totalCents: number;
    status: string;
    client: { displayName: string };
  } | null;
  stripePayout: {
    id: string;
    arrivalDate: string | null;
    status: string;
    amountCents: number;
  } | null;
};

type InvoiceOpt = {
  id: string;
  number: string | null;
  totalCents: number;
  status: string;
  client: { displayName: string };
  payments: Array<{ amountCents: number }>;
  /** Solde avoirs compris servi par l'API. */
  balance?: { dueCents: number } | null;
};

export function PaymentsPage() {
  const navigate = useNavigate();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [invoices, setInvoices] = useState<InvoiceOpt[]>([]);
  // Premier chargement et échec : tableau en squelette, puis erreur avec « Réessayer » (jamais un faux « aucun »).
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const online = useOnline();

  async function load() {
    const [pays, invs] = await Promise.all([
      api<Payment[]>("/api/payments"),
      api<InvoiceOpt[]>("/api/invoices"),
    ]);
    setPayments(pays);
    setInvoices(invs.filter((i) => i.status === "ISSUED" || i.status === "PAID"));
  }

  function fetchList() {
    setLoading(true);
    setLoadError(null);
    load()
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    fetchList();
  }, []);

  const openInvoices = useMemo(
    () =>
      invoices.map((i) => {
        const paid = i.payments.reduce((s, p) => s + p.amountCents, 0);
        // Reste dû avoirs compris (API) ; une facture soldée par avoir n'est plus proposée.
        return { ...i, remaining: i.balance?.dueCents ?? Math.max(0, i.totalCents - paid) };
      }).filter((i) => i.status === "ISSUED" && i.remaining > 0),
    [invoices],
  );

  const totalMonth = payments
    .filter((p) => {
      const d = new Date(p.paidAt);
      const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, p) => s + p.amountCents, 0);

  const columns: DataColumn<Payment>[] = [
    {
      name: "Date",
      selector: (p) => p.paidAt,
      sortable: true,
      width: "130px",
      cell: (p) => formatDate(p.paidAt),
    },
    {
      name: "Facture",
      selector: (p) => p.invoice?.number ?? "",
      sortable: true,
      width: "150px",
      cell: (p) =>
        p.invoice ? (
          <Link to={`/invoices/${p.invoice.id}`} className="rounded-[var(--radius-sm)] hover:opacity-80">
            <DocumentNumberBadge number={p.invoice.number} documentType="INVOICE" />
          </Link>
        ) : (
          <span className="text-[var(--muted)]">Sans facture</span>
        ),
    },
    {
      name: "Client",
      selector: (p) => p.invoice?.client.displayName ?? "",
      sortable: true,
      grow: 2,
      cell: (p) => (
        <span
          className="block truncate"
          title={p.invoice?.client.displayName ?? "Client non identifié"}
        >
          {p.invoice?.client.displayName ?? "Client non identifié"}
        </span>
      ),
    },
    {
      name: "Mode",
      showFrom: 1280,
      selector: (p) => p.method,
      sortable: true,
      width: "150px",
      cell: (p) => <Badge>{paymentMethodLabel[p.method] ?? p.method}</Badge>,
    },
    {
      name: "Montant",
      selector: (p) => p.amountCents,
      sortable: true,
      width: "140px",
      right: true,
      cell: (p) => (
        <span className="font-semibold tabular-nums">{formatEUR(p.amountCents)}</span>
      ),
    },
    {
      name: "Frais Stripe",
      showFrom: 1280,
      selector: (p) => p.feeCents ?? 0,
      sortable: true,
      width: "140px",
      right: true,
      cell: (p) =>
        p.feeCents != null ? (
          <span className="tabular-nums text-[var(--muted)]">{formatEUR(p.feeCents)}</span>
        ) : (
          <span className="text-[var(--muted)]">-</span>
        ),
    },
    {
      name: "Versement",
      showFrom: 1440,
      selector: (p) => p.stripePayout?.arrivalDate ?? "",
      sortable: true,
      width: "140px",
      cell: (p) =>
        p.stripePayout?.arrivalDate ? (
          <span className="text-sm text-[var(--muted)]" title={p.stripePayout.status}>
            {formatDate(p.stripePayout.arrivalDate)}
          </span>
        ) : p.stripePaymentIntentId ? (
          <span className="text-xs text-[var(--muted)]">En attente</span>
        ) : (
          <span className="text-[var(--muted)]">-</span>
        ),
    },
  ];

  const openCreate = useCallback(() => setOpen(true), []);
  useCreateParam(openCreate);
  useLiveRefresh(() => void load().catch(() => undefined), (i) => i.kind === "payment");
  // Facture présélectionnée : la première à encaisser, dès que la liste est chargée.
  useEffect(() => {
    if (open && !invoiceId && openInvoices[0]) setInvoiceId(openInvoices[0].id);
  }, [open, invoiceId, openInvoices]);

  return (
    <div>
      <PageHeader
        title="Encaissements"
        subtitle="Qui a payé, et combien"
        actions={
          <Button
            onClick={openCreate}
            disabled={openInvoices.length === 0}
          >
            Enregistrer un paiement
          </Button>
        }
      />

      <StatStrip
        busy={loading}
        className="mb-6"
        // Paiements jamais copiés hors ligne : pas de 0,00 € trompeur faute de réseau.
        items={loadError !== null && (!online || loadError === OFFLINE_MESSAGE) ? [
          { label: "Encaissé ce mois", value: "-", hint: "Consultable avec le réseau" },
          { label: "Paiements enregistrés", value: "-" },
          { label: "Factures à encaisser", value: "-" },
        ] : [
          { label: "Encaissé ce mois", value: formatEUR(totalMonth), tone: "success" },
          { label: "Paiements enregistrés", value: String(payments.length) },
          {
            label: "Factures à encaisser",
            value: String(openInvoices.length),
            hint: openInvoices.length ? "en attente de règlement" : "tout est réglé",
            tone: openInvoices.length ? "primary" : "default",
          },
        ]}
      />

      <DataTable
        columns={columns}
        data={payments}
        loading={loading}
        error={loadError}
        onRetry={fetchList}
        pagination
        perPage={25}
        searchable={["invoice.number", "invoice.client.displayName", "method", "reference"]}
        // Ligne entière cliquable (vers la facture), comme les autres listes ; même carte au téléphone.
        onRowClick={(p) => (p.invoice ? navigate(`/invoices/${p.invoice.id}`) : undefined)}
        countLabel={payments.length > 1 ? "paiements" : "paiement"}
        renderMobileCard={(p) => (
          <ListRow
            to={p.invoice ? `/invoices/${p.invoice.id}` : "/payments"}
            title={p.invoice?.client.displayName ?? "Client non identifié"}
            amount={formatEUR(p.amountCents)}
            meta={
              <>
                {p.invoice ? <DocumentNumberBadge number={p.invoice.number} documentType="INVOICE" /> : "Sans facture"}
                {` · ${formatDate(p.paidAt)}`}
              </>
            }
            badges={<Badge>{paymentMethodLabel[p.method] ?? p.method}</Badge>}
          />
        )}
        searchPlaceholder="Rechercher un paiement…"
        emptyTitle="Aucun paiement"
        emptyHint="Enregistrez un encaissement depuis une facture émise."
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Enregistrer un paiement"
        description="Choisissez la facture puis le montant réellement reçu."
      >
        <Field label="Facture" className="mb-4">
          <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            {openInvoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number ?? "Sans n°"} : {i.client.displayName} (reste{" "}
                {formatEUR(i.remaining)})
              </option>
            ))}
          </Select>
        </Field>
        {invoiceId ? (
          <PaymentForm
            invoiceId={invoiceId}
            defaultAmountEuros={(
              (openInvoices.find((i) => i.id === invoiceId)?.remaining ?? 0) / 100
            ).toFixed(2)}
            onCancel={() => setOpen(false)}
            onSuccess={async () => {
              setOpen(false);
              await load();
            }}
          />
        ) : null}
      </Modal>
    </div>
  );
}
