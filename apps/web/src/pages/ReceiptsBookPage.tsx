import { useMediaQuery } from "@/lib/use-media-query";
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
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui/Card";
import { StatStrip } from "@/components/ui/StatStrip";
import { Select } from "@/components/ui/Field";
import { Modal } from "@/components/ui/Modal";
import { ListRow } from "@/components/ui/ListRow";
import { DocumentNumberBadge } from "@/components/documents/DocumentNumberBadge";
import { shortNature } from "@/lib/receipt-nature";

const TYPE_TONE: Record<string, "teal" | "blue" | "violet" | "red" | "green" | "neutral"> = {
  Facture: "neutral",
  Acompte: "blue",
  Solde: "violet",
  Avoir: "red",
  Abonnement: "green",
};

/** Type de la pièce (colonne Type) : badges de même largeur, sur une ligne, alignés d'une ligne à l'autre. */
function ReceiptTypeBadge({ label, fixed = false }: { label: string; fixed?: boolean }) {
  return (
    <Badge tone={TYPE_TONE[label] ?? "neutral"} className={`whitespace-nowrap ${fixed ? "w-[6.75rem] justify-center" : ""}`}>
      {label}
    </Badge>
  );
}

type ReceiptRow = {
  id: string;
  paidAt: string;
  invoiceNumber: string | null;
  invoiceId: string | null;
  invoiceType?: string | null;
  documentType?: string | null;
  /** Facture, Acompte, Solde, Avoir, Abonnement (calculé par l'API, comme dans le CSV et le PDF). */
  typeLabel: string;
  amountCents: number;
  invoiceTotalCents?: number | null;
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

function fetchReceiptsPdf(queryParams: string): Promise<Blob> {
  return api<Blob>(`/api/receipts/pdf?${queryParams}`, { responseType: "blob" });
}

export function ReceiptsBookPage() {
  // Sous 640 px : libellés courts dans les listes déroulantes (le select garde son nom complet).
  const wide = useMediaQuery("(min-width: 40rem)");
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
      const blob = await api<Blob>(`/api/receipts/csv?${queryParams}`, { responseType: "blob" });
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

      {data && data.rows.length > 0 ? (
        <StatStrip
          className="mb-6"
          items={[
            { label: "Encaissé sur la période", value: formatEUR(data.totalCents), tone: "success" },
            { label: "Encaissements", value: String(data.rows.length) },
            {
              label: "Montant moyen",
              value: formatEUR(Math.round(data.totalCents / data.rows.length)),
            },
          ]}
        />
      ) : null}

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-[var(--border)] p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <h2 className="text-sm font-semibold">Registre chronologique</h2>
          {/* Sous 480 px : année et trimestre côte à côte, mois sur sa ligne (libellés entiers). */}
          <div className="grid w-full min-w-0 grid-cols-2 gap-2 min-[30rem]:grid-cols-3 sm:w-[30rem] [&_select]:min-w-0">
            <Select aria-label="Année" className="w-auto py-1.5 text-sm" value={year} onChange={(e) => setYear(e.target.value)}>
              {[thisYear, thisYear - 1, thisYear - 2].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Trimestre"
              className="w-auto py-1.5 text-sm"
              value={quarter}
              onChange={(e) => {
                setQuarter(e.target.value);
                setMonth("ALL");
              }}
            >
              <option value="ALL">{wide ? "Toute l'année" : "Année"}</option>
              <option value="1">T1</option>
              <option value="2">T2</option>
              <option value="3">T3</option>
              <option value="4">T4</option>
            </Select>
            <Select
              aria-label="Mois"
              className="col-span-2 w-auto py-1.5 text-sm min-[30rem]:col-span-1"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                if (e.target.value !== "ALL") setQuarter("ALL");
              }}
            >
              <option value="ALL">{wide ? "Tous les mois" : "Mois"}</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  {new Date(2000, i, 1).toLocaleString("fr-FR", { month: wide ? "long" : "short" })}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {loading ? (
          <p className="p-8 text-sm text-[var(--muted)]">Chargement…</p>
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            title="Aucun encaissement"
            hint="Les paiements enregistrés sur les factures apparaissent ici."
          />
        ) : (
          <>
            {/* Téléphone : une ligne par encaissement (gabarit des listes), le type en badge dans la ligne de méta. */}
            <ul className="space-y-2 p-3 md:hidden" aria-label="Encaissements">
              {data.rows.map((r) => (
                <li key={r.id}>
                  <ListRow
                    to={r.invoiceId ? `/invoices/${r.invoiceId}` : undefined}
                    title={r.clientName}
                    amount={formatEUR(r.amountCents)}
                    meta={[formatDate(r.paidAt), r.invoiceNumber ?? "Sans facture", r.paymentMethodLabel].join(" · ")}
                    badges={<ReceiptTypeBadge label={r.typeLabel} />}
                  />
                </li>
              ))}
            </ul>
            <div className="ui-table-wrap max-md:hidden">
              <table className="ui-table">
                <caption className="sr-only">Livre des recettes : encaissements de la période, par date</caption>
                <thead>
                  <tr>
                    <th scope="col" className="nowrap">Date</th>
                    <th scope="col" className="nowrap">Facture</th>
                    <th scope="col" className="nowrap">Type</th>
                    <th scope="col">Client</th>
                    <th scope="col" className="w-full md:max-xl:hidden">Nature</th>
                    <th scope="col" className="nowrap">Règlement</th>
                    <th scope="col" className="nowrap text-right">Encaissé</th>
                    <th scope="col" className="nowrap text-right">Total facture</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const nature = shortNature(r.nature, r.typeLabel);
                    return (
                      <tr key={r.id}>
                        <td className="nowrap tabular-nums text-[var(--muted)]">{formatDate(r.paidAt)}</td>
                        <td className="nowrap">
                          {r.invoiceId ? (
                            <Link to={`/invoices/${r.invoiceId}`} className="inline-flex min-h-11 items-center">
                              <DocumentNumberBadge
                                number={r.invoiceNumber}
                                documentType={r.documentType ?? "INVOICE"}
                                invoiceType={r.invoiceType ?? undefined}
                              />
                            </Link>
                          ) : (
                            <span className="text-[var(--muted)]">-</span>
                          )}
                        </td>
                        <td className="nowrap">
                          <ReceiptTypeBadge label={r.typeLabel} fixed />
                        </td>
                        <td className="nowrap">
                          <span className="block max-w-[16rem] truncate font-medium" title={r.clientName}>
                            {r.clientName}
                          </span>
                          {r.clientNumber ? (
                            <span className="block font-mono text-[length:var(--text-ref)] text-[var(--muted)]">{r.clientNumber}</span>
                          ) : null}
                        </td>
                        {/* Une seule ligne, une ellipse : le texte légal complet est dans title et reste lu en entier. */}
                        <td className="max-w-0 text-[var(--muted)] md:max-xl:hidden" title={r.nature}>
                          <span className="block truncate">{nature}</span>
                        </td>
                        <td className="nowrap">{r.paymentMethodLabel}</td>
                        <td className="nowrap text-right font-semibold tabular-nums">{formatEUR(r.amountCents)}</td>
                        <td className="nowrap text-right tabular-nums text-[var(--muted)]">
                          {r.invoiceTotalCents != null ? formatEUR(r.invoiceTotalCents) : "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-[var(--border-strong)] bg-[var(--bg-subtle)]">
                    <th scope="row" colSpan={4} className="text-left text-[length:var(--text-table)] font-normal normal-case tracking-normal text-[var(--muted)]">
                      {data.rows.length} encaissement{data.rows.length > 1 ? "s" : ""}
                    </th>
                    <td className="md:max-xl:hidden" />
                    <th scope="row" className="text-right text-[length:var(--text-table)] normal-case tracking-normal text-[var(--text)]">
                      Total
                    </th>
                    <td className="nowrap text-right font-semibold tabular-nums">{formatEUR(data.totalCents)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="flex items-center justify-between border-t border-[var(--border)] px-4 py-3 text-sm md:hidden">
              <span className="text-[var(--muted)]">
                {data.rows.length} encaissement{data.rows.length > 1 ? "s" : ""}
              </span>
              <span className="font-semibold tabular-nums">Total {formatEUR(data.totalCents)}</span>
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
