import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { api, formatEUR } from "@/lib/api";
import { formatDate, paymentMethodLabel } from "@/lib/format";
import { Badge, Card, PageHeader } from "@/components/ui/Card";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { DataTable, type TableColumn } from "@/components/ui/DataTable";
import { PaymentForm } from "@/components/payments/PaymentForm";
import { Select } from "@/components/ui/Field";

type Payment = {
  id: string;
  amountCents: number;
  paidAt: string;
  method: string;
  reference: string | null;
  invoice: {
    id: string;
    number: string | null;
    totalCents: number;
    status: string;
    client: { displayName: string };
  };
};

type InvoiceOpt = {
  id: string;
  number: string | null;
  totalCents: number;
  status: string;
  client: { displayName: string };
  payments: Array<{ amountCents: number }>;
};

export function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [invoices, setInvoices] = useState<InvoiceOpt[]>([]);
  const [open, setOpen] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");

  async function load() {
    const [pays, invs] = await Promise.all([
      api<Payment[]>("/api/payments"),
      api<InvoiceOpt[]>("/api/invoices"),
    ]);
    setPayments(pays);
    setInvoices(invs.filter((i) => i.status === "ISSUED" || i.status === "PAID"));
  }

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
  }, []);

  const openInvoices = useMemo(
    () =>
      invoices.map((i) => {
        const paid = i.payments.reduce((s, p) => s + p.amountCents, 0);
        return { ...i, remaining: Math.max(0, i.totalCents - paid) };
      }).filter((i) => i.remaining > 0 || i.status === "ISSUED"),
    [invoices],
  );

  const totalMonth = payments
    .filter((p) => {
      const d = new Date(p.paidAt);
      const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, p) => s + p.amountCents, 0);

  const columns: TableColumn<Payment>[] = [
    {
      name: "Date",
      selector: (p) => p.paidAt,
      sortable: true,
      width: "130px",
      cell: (p) => formatDate(p.paidAt),
    },
    {
      name: "Facture",
      selector: (p) => p.invoice.number ?? "",
      sortable: true,
      width: "150px",
      cell: (p) => (
        <Link
          to={`/invoices/${p.invoice.id}`}
          className="font-medium text-[var(--primary)] hover:underline"
        >
          {p.invoice.number ?? "-"}
        </Link>
      ),
    },
    {
      name: "Client",
      selector: (p) => p.invoice.client.displayName,
      sortable: true,
      grow: 2,
      minWidth: "180px",
      cell: (p) => (
        <span className="block truncate" title={p.invoice.client.displayName}>
          {p.invoice.client.displayName}
        </span>
      ),
    },
    {
      name: "Mode",
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
        <span className="tabular-nums font-medium">{formatEUR(p.amountCents)}</span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Paiements"
        subtitle="Suivi des encaissements sur factures émises"
        actions={
          <Button
            onClick={() => {
              setInvoiceId(openInvoices[0]?.id ?? "");
              setOpen(true);
            }}
            disabled={openInvoices.length === 0}
          >
            Enregistrer un paiement
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-[var(--muted)]">Encaissé ce mois</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{formatEUR(totalMonth)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-[var(--muted)]">Paiements enregistrés</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{payments.length}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-[var(--muted)]">Factures à encaisser</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{openInvoices.length}</p>
        </Card>
      </div>

      <DataTable
        columns={columns}
        data={payments}
        pagination
        perPage={25}
        searchable={["invoice.number", "invoice.client.displayName", "method"]}
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
        <div className="mb-4">
          <label className="mb-1.5 block text-sm font-medium">Facture</label>
          <Select value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)}>
            {openInvoices.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number ?? "Sans n°"} : {i.client.displayName} (reste{" "}
                {formatEUR(i.remaining)})
              </option>
            ))}
          </Select>
        </div>
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
