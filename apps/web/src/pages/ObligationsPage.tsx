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
import { Card, PageHeader } from "@/components/ui/Card";

export type ObligationItem = {
  id: string;
  type: string;
  period: string;
  dueDate: string;
  displayStatus: "LATE" | "PENDING" | "URGENT" | "DONE";
  completedAt: string | null;
  amountCents: number | null;
  notes: string | null;
  label: string;
  daysLate: number | null;
  daysRemaining: number | null;
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
      return "text-red-600";
    case "URGENT":
      return "text-amber-500";
    case "DONE":
      return "text-green-600";
    default:
      return "text-[var(--muted)]";
  }
}

function statusLabel(item: ObligationItem): string {
  switch (item.displayStatus) {
    case "LATE":
      return `En retard (${item.daysLate ?? 0} j)`;
    case "URGENT":
      return `Plus que ${item.daysRemaining ?? 0} j`;
    case "DONE":
      return `Confirmé le ${formatDate(item.completedAt)}`;
    default:
      return item.daysRemaining != null ? `Dans ${item.daysRemaining} j` : "À venir";
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

  return (
    <div className="flex flex-wrap items-start gap-3 border-b border-gray-200 py-4 last:border-0">
      <div
        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--bg)] ${tone}`}
      >
        <FontAwesomeIcon icon={iconFor(item.type)} className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.label}</p>
        <p className="text-xs text-[var(--muted)]">
          Échéance {formatDate(item.dueDate)}
          {item.amountCents != null ? ` · ${formatEUR(item.amountCents)}` : ""}
          {item.period ? ` · ${item.period}` : ""}
        </p>
        {item.notes ? (
          <p className="mt-0.5 text-xs text-[var(--muted)]">{item.notes}</p>
        ) : null}
        <p className={`mt-0.5 text-xs font-medium ${tone}`}>{statusLabel(item)}</p>
        {item.hasAttachment ? (
          <a
            href={`/api/obligations/${item.id}/attachment`}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex items-center gap-1.5 text-xs text-[var(--primary)] hover:underline"
          >
            <FontAwesomeIcon icon={faFilePdf} className="h-3 w-3" />
            {item.attachmentName ?? "Justificatif PDF"}
          </a>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {showConfirm ? (
          <a
            href={item.officialUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius)] border border-gray-200 bg-white px-3 text-xs font-medium hover:bg-[var(--bg)]"
          >
            Site officiel
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-3 w-3" />
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
        <Button
          type="button"
          variant="secondary"
          className="h-8 px-3 text-xs"
          onClick={() => inputRef.current?.click()}
        >
          <FontAwesomeIcon icon={faPaperclip} className="h-3 w-3" />
          {item.hasAttachment ? "Remplacer PDF" : "Joindre PDF"}
        </Button>
        {showConfirm ? (
          <Button
            className="h-8 px-3 text-xs"
            disabled={busy}
            onClick={() => onConfirm(item.id)}
          >
            <FontAwesomeIcon icon={faCheck} className="h-3 w-3" />
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

  useEffect(() => {
    load().catch((e: Error) => toast.error(e.message));
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
    return <p className="text-sm text-[var(--muted)]">Chargement…</p>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Obligations administratives"
        subtitle="URSSAF, CFE, impôts - historique et justificatifs PDF"
      />

      {data.alerts.length > 0 ? (
        <ul className="space-y-2">
          {data.alerts.map((a) => (
            <li
              key={a.kind}
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            >
              {a.message}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-[var(--muted)]">En retard</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-red-600">
            {data.summary.late}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-[var(--muted)]">Urgentes</p>
          <p className="mt-1 text-xl font-semibold tabular-nums text-amber-500">
            {data.summary.urgent}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-[var(--muted)]">À venir</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{data.summary.pending}</p>
        </Card>
      </div>

      <Card className="border border-gray-200 p-5">
        <h2 className="mb-1 text-sm font-semibold">À traiter</h2>
        <p className="mb-3 text-xs text-[var(--muted)]">
          Un seul geste : confirmer après déclaration/paiement. La prochaine échéance est créée
          automatiquement.
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

      <Card className="border border-gray-200 p-5">
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
