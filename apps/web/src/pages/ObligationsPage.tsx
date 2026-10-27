import { useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faShieldHalved,
  faBuildingColumns,
  faFileInvoice,
  faClipboardList,
  faArrowUpRightFromSquare,
  faCheck,
  faPaperclip,
  faFilePdf,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { toast } from "sonner";
import { api, formatEUR, formatDate } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { StatStrip } from "@/components/ui/StatStrip";
import { Card, PageHeader } from "@/components/ui/Card";
import { LoadState } from "@/pages/site/shared";

export type ObligationItem = {
  id: string;
  type: string;
  period: string;
  dueDate: string;
  windowStart: string;
  windowEnd: string;
  displayStatus: "UPCOMING" | "OPEN" | "LATE" | "URGENT" | "DONE" | "TO_CHECK";
  completedAt: string | null;
  amountCents: number | null;
  notes: string | null;
  label: string;
  daysLate: number | null;
  daysRemaining: number | null;
  daysUntilOpen: number | null;
  officialUrl: string;
  confirmLabel: string;
  attachmentName: string | null;
  hasAttachment: boolean;
};

type ObligationsPayload = {
  items: ObligationItem[];
  history: ObligationItem[];
  alerts: Array<{ kind: string; message: string }>;
  summary: {
    late: number;
    urgent: number;
    open: number;
    upcoming: number;
    pending: number;
  };
};

function iconFor(type: string): IconDefinition {
  switch (type) {
    case "URSSAF_DECLARATION":
      return faShieldHalved;
    case "CFE_PAYMENT":
    case "CFE_INITIAL_DECLARATION":
      return faBuildingColumns;
    case "INCOME_TAX_DECLARATION":
      return faFileInvoice;
    default:
      return faClipboardList;
  }
}

function statusClass(status: ObligationItem["displayStatus"]): string {
  switch (status) {
    case "LATE":
      return "text-[var(--danger)]";
    case "URGENT":
      return "text-[var(--warning)]";
    case "OPEN":
      return "text-[var(--primary)]";
    case "DONE":
      return "text-[var(--success)]";
    default:
      return "text-[var(--muted)]";
  }
}

function statusLabel(item: ObligationItem): string {
  switch (item.displayStatus) {
    case "LATE":
      return `En retard (${item.daysLate ?? 0} j après clôture)`;
    case "URGENT":
      return `Clôture dans ${item.daysRemaining ?? 0} j`;
    case "OPEN":
      return `Ouvert · clôture dans ${item.daysRemaining ?? 0} j`;
    case "UPCOMING":
      return `Ouverture dans ${item.daysUntilOpen ?? 0} j`;
    case "DONE":
      return `Confirmé le ${formatDate(item.completedAt)}`;
    case "TO_CHECK":
      // Période passée ajoutée au rattrapage : peut-être déjà déclarée hors de l'ERP, jamais affichée en retard.
      return "À vérifier : déjà déclarée ?";
    default:
      return "À venir";
  }
}

function ObligationRow({
  item,
  busy,
  onConfirm,
  onUploaded,
  showConfirm,
}: {
  item: ObligationItem;
  busy?: boolean;
  onConfirm: (id: string) => void;
  onUploaded: () => void;
  showConfirm: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const tone = statusClass(item.displayStatus);
  const alertActive = item.displayStatus === "OPEN" || item.displayStatus === "URGENT" || item.displayStatus === "LATE";

  async function upload(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    try {
      await api(`/api/obligations/${item.id}/attachment`, {
        method: "POST",
        body: fd,
      });
      toast.success("PDF enregistré");
      onUploaded();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload impossible");
    }
  }

  const iconBtn =
    "inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border)] text-[var(--muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]";

  return (
    <div className="flex flex-col gap-3 border-b border-[var(--border)] py-4 last:border-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--bg-subtle)] ${tone}`}>
          <FontAwesomeIcon icon={iconFor(item.type)} className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{item.label}</p>
            <span className={`text-xs font-medium ${tone}`}>{statusLabel(item)}</span>
          </div>
          <p className="mt-0.5 text-xs text-[var(--muted)]">
            Du {formatDate(item.windowStart)} au {formatDate(item.windowEnd)}
            {item.amountCents != null ? ` · ${formatEUR(item.amountCents)}` : ""}
          </p>
          {item.notes ? <p className="mt-0.5 text-xs text-[var(--muted)]">{item.notes}</p> : null}
          {item.hasAttachment ? (
            <a
              href={`/api/obligations/${item.id}/attachment`}
              target="_blank"
              rel="noreferrer"
              className="link mt-1 inline-flex items-center gap-1.5 text-xs"
            >
              <FontAwesomeIcon icon={faFilePdf} className="h-3 w-3" aria-hidden />
              {item.attachmentName ?? "Justificatif PDF"}
            </a>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 pl-12 sm:shrink-0 sm:flex-nowrap sm:pl-0">
        {showConfirm && item.officialUrl ? (
          <a
            href={item.officialUrl}
            target="_blank"
            rel="noreferrer"
            className={iconBtn}
            aria-label={`Site officiel : ${item.label} (nouvel onglet)`}
            title="Site officiel"
          >
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className={iconBtn}
          aria-label={item.hasAttachment ? `Remplacer le justificatif : ${item.label}` : `Joindre un justificatif : ${item.label}`}
          title={item.hasAttachment ? "Remplacer le PDF" : "Joindre un PDF"}
          onClick={() => inputRef.current?.click()}
        >
          <FontAwesomeIcon icon={faPaperclip} className="h-3.5 w-3.5" aria-hidden />
        </button>
        {showConfirm && alertActive ? (
          <Button className="min-w-0 flex-1 px-3 text-sm sm:flex-none" disabled={busy} onClick={() => onConfirm(item.id)}>
            <FontAwesomeIcon icon={faCheck} className="h-3 w-3" aria-hidden />
            {item.confirmLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ObligationsPage() {
  const [data, setData] = useState<ObligationsPayload | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setData(await api<ObligationsPayload>("/api/obligations"));
  }

  // Échec du chargement : message et « Réessayer » au lieu d'un « Chargement… » sans fin (audit du 27/10/2026).
  const [loadError, setLoadError] = useState<string | null>(null);
  function reload() {
    setLoadError(null);
    load().catch((e: Error) => setLoadError(e.message || "Chargement des démarches impossible"));
  }

  useEffect(() => {
    reload();
  }, []);

  async function confirm(id: string) {
    setBusyId(id);
    try {
      await api(`/api/obligations/${id}/confirm`, { method: "POST", body: "{}" });
      toast.success("Confirmé - prochaine échéance planifiée");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusyId(null);
    }
  }

  if (!data) {
    return (
      <LoadState loading={!loadError} error={loadError} onRetry={reload}>
        {null}
      </LoadState>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Démarches à faire"
        subtitle="Fenêtres de déclaration : alerte dès l'ouverture, clôture au dernier délai"
      />

      {data.alerts.length > 0 ? (
        <ul className="space-y-2">
          {data.alerts.map((a) => (
            <li
              key={a.kind}
              className="rounded-md border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-3 py-2 text-xs text-[var(--warning)]"
            >
              {a.message}
            </li>
          ))}
        </ul>
      ) : null}

      <StatStrip
        items={[
          { label: "En retard", value: String(data.summary.late), tone: data.summary.late ? "danger" : "default" },
          { label: "Urgentes", value: String(data.summary.urgent), tone: data.summary.urgent ? "warning" : "default" },
          { label: "Ouvertes", value: String(data.summary.open), tone: data.summary.open ? "primary" : "default" },
          { label: "À venir", value: String(data.summary.upcoming), hint: "fenêtre pas encore ouverte" },
        ]}
      />

      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold">À traiter</h2>
        <p className="mb-3 text-xs text-[var(--muted)]">
          L&apos;alerte démarre à l&apos;ouverture de chaque fenêtre. Rappels par email (si activés) à J-7, J-3, J-1 et le jour de clôture. Confirmez après déclaration ou paiement.
        </p>
        {data.items.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Rien en cours.</p>
        ) : (
          data.items.map((item) => (
            <ObligationRow
              key={item.id}
              item={item}
              busy={busyId === item.id}
              onConfirm={confirm}
              onUploaded={() => void load()}
              showConfirm
            />
          ))
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold">Historique</h2>
        <p className="mb-3 text-xs text-[var(--muted)]">
          Confirmations passées - joignez le PDF de déclaration pour archivage.
        </p>
        {data.history.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">Aucun historique pour le moment.</p>
        ) : (
          data.history.map((item) => (
            <ObligationRow
              key={item.id}
              item={item}
              onConfirm={confirm}
              onUploaded={() => void load()}
              showConfirm={false}
            />
          ))
        )}
      </Card>
    </div>
  );
}
