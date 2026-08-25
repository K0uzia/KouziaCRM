import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowRight } from "@fortawesome/free-solid-svg-icons";
import { api, formatDate } from "@/lib/api";
import { Card } from "@/components/ui/Card";

type SummaryPayload = {
  summary: {
    late: number;
    urgent: number;
    pending: number;
  };
  nextDue: {
    label: string;
    dueDate: string;
    displayStatus: string;
    daysLate: number | null;
    daysRemaining: number | null;
  } | null;
};

export function ObligationsReminder() {
  const [data, setData] = useState<SummaryPayload | null>(null);

  useEffect(() => {
    api<SummaryPayload>("/api/obligations/summary")
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return null;

  const { summary, nextDue } = data;
  const open = summary.pending + summary.late + summary.urgent;
  const hint = nextDue
    ? nextDue.displayStatus === "LATE"
      ? `en retard (${nextDue.daysLate ?? 0} j)`
      : nextDue.displayStatus === "URGENT"
        ? `dans ${nextDue.daysRemaining ?? 0} j`
        : formatDate(nextDue.dueDate)
    : null;

  return (
    <Card className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm">
            <span
              className={
                summary.late > 0
                  ? "font-medium text-red-700"
                  : summary.urgent > 0
                    ? "font-medium text-amber-700"
                    : "font-medium text-green-700"
              }
            >
              {summary.late > 0
                ? `${summary.late} obligation(s) en retard`
                : summary.urgent > 0
                  ? `${summary.urgent} urgente(s)`
                  : "Obligations à jour"}
            </span>
            {open > 0 ? (
              <span className="text-[var(--muted)]"> · {open} ouverte(s)</span>
            ) : null}
          </p>
          {nextDue ? (
            <p className="mt-0.5 truncate text-xs text-[var(--muted)]">
              Prochaine : {nextDue.label}
              {hint ? ` · ${hint}` : ""}
            </p>
          ) : null}
        </div>
        <Link
          to="/obligations"
          className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-[var(--primary)] hover:underline"
        >
          Voir
          <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" />
        </Link>
      </div>
    </Card>
  );
}
