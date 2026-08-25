import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faFileCsv,
  faFilePdf,
  faDownload,
  faEye,
} from "@fortawesome/free-solid-svg-icons";
import { toast } from "sonner";
import { api, formatEUR, formatDate } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { Select } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { DocumentNumberBadge } from "@/components/documents/DocumentNumberBadge";
import { InvoiceTypeBadge } from "@/components/documents/InvoiceTypeBadge";

type ReceiptRow = {
  id: string;
  paidAt: string;
  invoiceNumber: string | null;
  invoiceId: string;
  invoiceType?: string;
  documentType?: string;
  amountCents: number;
  clientName: string;
  clientNumber: string | null;
  nature: string;
  paymentMethod: string;
  paymentMethodLabel: string;
  reference: string | null;
};

type ReceiptsData = {
  period: { start: string; end: string; year: number };
  rows: ReceiptRow[];
  totalCents: number;
};

async function fetchReceiptsPdf(queryParams: string): Promise<Blob> {
  const res = await fetch(`/api/receipts/pdf?${queryParams}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Export PDF impossible");
  return res.blob();
}

export function ReceiptsBookPage() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(String(thisYear));
  const [quarter, setQuarter] = useState("ALL");
  const [month, setMonth] = useState("ALL");
  const [data, setData] = useState<ReceiptsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pdfMenuOpen, setPdfMenuOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  const queryParams = useMemo(() => {
    const p = new URLSearchParams({ year });
    if (month !== "ALL") p.set("month", month);
    else if (quarter !== "ALL") p.set("quarter", quarter);
    return p.toString();
  }, [year, quarter, month]);

  useEffect(() => {
    setLoading(true);
    api<ReceiptsData>(`/api/receipts?${queryParams}`)
      .then(setData)
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, [queryParams]);

  async function exportCsv() {
    try {
      const res = await fetch(`/api/receipts/csv?${queryParams}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Export CSV impossible");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `livre-recettes-${year}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("CSV téléchargé");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur CSV");
    }
  }

  async function viewPdf() {
    setPdfBusy(true);
    try {
      const blob = await fetchReceiptsPdf(queryParams);
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (!win) {
        toast.error("Autorisez les pop-ups pour ouvrir le document");
        URL.revokeObjectURL(url);
        return;
      }
      setPdfMenuOpen(false);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur PDF");
    } finally {
      setPdfBusy(false);
    }
  }

  async function downloadPdf() {
    setPdfBusy(true);
    try {
      const blob = await fetchReceiptsPdf(queryParams);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `livre-recettes-${year}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      setPdfMenuOpen(false);
      toast.success("PDF téléchargé");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur PDF");
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Livre des recettes"
        subtitle="Registre chronologique des encaissements"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => void exportCsv()}
              disabled={!data?.rows.length}
            >
              <FontAwesomeIcon icon={faFileCsv} className="h-3.5 w-3.5" />
              CSV
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPdfMenuOpen(true)}
              disabled={!data?.rows.length}
            >
              <FontAwesomeIcon icon={faFilePdf} className="h-3.5 w-3.5" />
              PDF
            </Button>
          </div>
        }
      />

      <Modal
        open={pdfMenuOpen}
        onClose={() => setPdfMenuOpen(false)}
        title="Export PDF"
        description="Ouvrir dans un nouvel onglet ou télécharger le fichier."
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" onClick={() => void viewPdf()} disabled={pdfBusy}>
            <FontAwesomeIcon icon={faEye} className="h-3.5 w-3.5" />
            Voir
          </Button>
          <Button
            className="flex-1"
            variant="secondary"
            onClick={() => void downloadPdf()}
            disabled={pdfBusy}
          >
            <FontAwesomeIcon icon={faDownload} className="h-3.5 w-3.5" />
            Télécharger
          </Button>
        </div>
      </Modal>

      <div className="mb-4 flex flex-wrap gap-3">
        <Select className="w-auto" value={year} onChange={(e) => setYear(e.target.value)}>
          {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </Select>
        <Select
          className="w-auto"
          value={quarter}
          onChange={(e) => {
            setQuarter(e.target.value);
            setMonth("ALL");
          }}
        >
          <option value="ALL">Toute l&apos;année</option>
          <option value="1">T1</option>
          <option value="2">T2</option>
          <option value="3">T3</option>
          <option value="4">T4</option>
        </Select>
        <Select
          className="w-auto"
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            if (e.target.value !== "ALL") setQuarter("ALL");
          }}
        >
          <option value="ALL">Tous les mois</option>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i + 1} value={String(i + 1)}>
              {new Date(2000, i, 1).toLocaleString("fr-FR", { month: "long" })}
            </option>
          ))}
        </Select>
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <p className="p-8 text-sm text-[var(--muted)]">Chargement…</p>
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            title="Aucun encaissement"
            hint="Les paiements enregistrés sur les factures apparaissent ici."
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead className="border-b border-[var(--border)] text-[var(--muted)]">
                  <tr>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Facture</th>
                    <th className="px-4 py-3 font-medium">Code client</th>
                    <th className="px-4 py-3 font-medium">Client</th>
                    <th className="px-4 py-3 font-medium">Nature</th>
                    <th className="px-4 py-3 font-medium">Règlement</th>
                    <th className="px-4 py-3 text-right font-medium">Montant</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="border-t border-[var(--border)]">
                      <td className="whitespace-nowrap px-4 py-3 text-[var(--muted)]">
                        {formatDate(r.paidAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Link to={`/invoices/${r.invoiceId}`}>
                            <DocumentNumberBadge
                              number={r.invoiceNumber}
                              documentType={r.documentType ?? "INVOICE"}
                              invoiceType={r.invoiceType}
                            />
                          </Link>
                          <InvoiceTypeBadge type={r.invoiceType} />
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">
                        {r.clientNumber ?? "-"}
                      </td>
                      <td className="px-4 py-3 font-medium">{r.clientName}</td>
                      <td
                        className="max-w-[14rem] truncate px-4 py-3 text-[var(--muted)]"
                        title={r.nature}
                      >
                        {r.nature}
                      </td>
                      <td className="px-4 py-3">{r.paymentMethodLabel}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">
                        {formatEUR(r.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3 text-sm">
              <span className="text-[var(--muted)]">{data.rows.length} encaissement(s)</span>
              <span className="font-semibold tabular-nums">
                Total {formatEUR(data.totalCents)}
              </span>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
