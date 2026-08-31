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
    open: number;
    upcoming: number;
    pending: number;
  };
  nextDue: {
    label: string;
    dueDate: string;
    windowStart: string;
    windowEnd: string;
    displayStatus: string;
    daysLate: number | null;
    daysRemaining: number | null;
    daysUntilOpen: number | null;
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
  const alertCount = summary.late + summary.urgent + summary.open;
  const hint = nextDue
    ? nextDue.displayStatus === "LATE"
      ? `en retard (${nextDue.daysLate ?? 0} j)`
      : nextDue.displayStatus === "URGENT"
        ? `clôture dans ${nextDue.daysRemaining ?? 0} j`
        : nextDue.displayStatus === "OPEN"
          ? `ouvert · clôture ${formatDate(nextDue.windowEnd)}`
          : nextDue.displayStatus === "UPCOMING"
            ? `ouverture ${formatDate(nextDue.windowStart)}`
            : formatDate(nextDue.windowEnd)
    : null;

  return (
    <Card className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm">
            <span
              className={
                summary.late > 0
                  ? "font-medium text-[var(--danger)]"
                  : summary.urgent > 0
                    ? "font-medium text-[var(--warning)]"
                    : summary.open > 0
                      ? "font-medium text-[var(--primary)]"
                      : "font-medium text-[var(--success)]"
              }
            >
              {summary.late > 0
                ? `${summary.late} démarche(s) en retard`
                : summary.urgent > 0
                  ? `${summary.urgent} urgente(s)`
                  : summary.open > 0
                    ? `${summary.open} démarche(s) ouverte(s)`
                    : summary.upcoming > 0
                      ? `${summary.upcoming} à venir`
                      : "Rien à faire pour l'instant"}
            </span>
            {alertCount > 0 ? (
              <span className="text-[var(--muted)]"> · {alertCount} à traiter</span>
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
          className="link inline-flex shrink-0 items-center gap-1.5 text-xs font-medium"
        >
          Voir
          <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3" />
        </Link>
      </div>
    </Card>
  );
}
