import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faXmark } from "@fortawesome/free-solid-svg-icons";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

type Project = { id: string; quoteId: string | null; name: string; status: string; startedAt: string | null; progress: number };

type Milestone = { position: number; status: string; invoiceId?: string | null };

/**
 * Parcours d'un devis jusqu'au démarrage du projet :
 * émis → validé → acompte facturé (projet créé) → acompte payé → démarrage.
 */
export function QuoteJourney({
  quote,
  milestones,
}: {
  quote: { id: string; clientId: string; issueDate: string | null; quoteStatus?: string | null; quoteDecidedAt?: string | null };
  milestones: Milestone[];
}) {
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    api<Project[]>(`/api/clients/${quote.clientId}/projects`)
      .then((rows) => setProject(rows.find((p) => p.quoteId === quote.id) ?? null))
      .catch(() => setProject(null));
  }, [quote.clientId, quote.id]);

  const deposit = [...milestones].sort((a, b) => a.position - b.position)[0];
  const accepted = quote.quoteStatus === "ACCEPTED";
  const steps = [
    { label: "Devis émis", done: Boolean(quote.issueDate), detail: quote.issueDate ? formatDate(quote.issueDate) : null },
    {
      label: "Devis validé par le client",
      done: accepted,
      detail: accepted && quote.quoteDecidedAt ? formatDate(quote.quoteDecidedAt) : quote.quoteStatus === "REJECTED" ? "refusé" : null,
    },
    {
      label: "Facture d'acompte",
      done: Boolean(deposit && (deposit.invoiceId || deposit.status === "INVOICED" || deposit.status === "PAID")),
      detail: null,
    },
    { label: "Acompte payé", done: deposit?.status === "PAID", detail: null },
    {
      label: "Projet créé et démarré",
      done: Boolean(project) && (project?.status === "ACTIVE" || project?.status === "DONE"),
      detail: project ? `${project.name}${project.startedAt ? ` · ${formatDate(project.startedAt)}` : ""}` : null,
    },
  ];
  const rejected = quote.quoteStatus === "REJECTED" || quote.quoteStatus === "EXPIRED";
  if (rejected) {
    steps.splice(1, steps.length - 1, {
      label: quote.quoteStatus === "EXPIRED" ? "Devis expiré" : "Devis refusé par le client",
      done: false,
      detail: quote.quoteDecidedAt ? formatDate(quote.quoteDecidedAt) : null,
    });
  }
  const currentIndex = rejected ? -1 : steps.findIndex((s) => !s.done);

  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold">Parcours</h2>
      <ol className="space-y-0">
        {steps.map((s, i) => {
          const current = i === currentIndex;
          return (
            <li key={s.label} className="relative flex gap-3 pb-4 last:pb-0">
              {i < steps.length - 1 ? (
                <span
                  className={`absolute left-[0.6875rem] top-6 h-[calc(100%-1.25rem)] w-px ${s.done ? "bg-[var(--success)]/50" : "bg-[var(--border)]"}`}
                  aria-hidden
                />
              ) : null}
              <span
                className={`relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[0.625rem] ${
                  rejected && i === 1
                    ? "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]"
                    : s.done
                    ? "border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)]"
                    : current
                      ? "border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--primary)]"
                      : "border-[var(--border-strong)] text-[var(--muted)]"
                }`}
                aria-hidden
              >
                {rejected && i === 1 ? <FontAwesomeIcon icon={faXmark} className="h-2.5 w-2.5" /> : s.done ? <FontAwesomeIcon icon={faCheck} className="h-2.5 w-2.5" /> : i + 1}
              </span>
              <div className="min-w-0 pt-0.5">
                <p className={`text-sm ${rejected && i === 1 ? "font-medium text-[var(--danger)]" : s.done ? "" : current ? "font-medium text-[var(--primary)]" : "text-[var(--muted)]"}`}>
                  {s.label}
                  <span className="sr-only">{s.done ? " (fait)" : current ? " (étape en cours)" : " (à venir)"}</span>
                </p>
                {s.detail ? <p className="truncate text-xs text-[var(--muted)]">{s.detail}</p> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {project ? (
        <Link to={`/clients/${quote.clientId}?tab=projets`} className="link mt-2 inline-flex min-h-11 items-center text-sm">
          Voir le projet ({project.progress} %)
        </Link>
      ) : accepted && !rejected ? (
        <p className="mt-3 text-xs text-[var(--muted)]">Le projet sera créé au paiement de l&apos;acompte.</p>
      ) : null}
    </div>
  );
}
