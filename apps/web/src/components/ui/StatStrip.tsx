import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export type StatItem = {
  label: string;
  value: ReactNode;
  /** Ligne secondaire (contexte, échéance). */
  hint?: ReactNode;
  tone?: "default" | "primary" | "success" | "warning" | "danger";
  /** Écran détaillé : la case devient un lien. */
  to?: string;
};

const toneClass: Record<NonNullable<StatItem["tone"]>, string> = {
  default: "text-[var(--text)]",
  primary: "text-[var(--primary)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  danger: "text-[var(--danger)]",
};

const cols: Record<number, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 sm:grid-cols-3",
  4: "grid-cols-2 lg:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 2xl:grid-cols-6",
};

/** Bandeau d'indicateurs dans une seule carte ; les filets sont l'espace d'1 px entre cases. */
export function StatStrip({ items, className = "" }: { items: StatItem[]; className?: string }) {
  return (
    <dl
      className={`ui-card grid gap-px overflow-hidden bg-[var(--border)] ${cols[items.length] ?? cols[4]} ${className}`}
    >
      {items.map((s) => {
        const content = (
          <>
            <dt className="truncate text-xs font-medium text-[var(--muted)] sm:text-sm">{s.label}</dt>
            <dd
              className={`mt-1.5 font-display text-xl font-semibold tabular-nums tracking-tight sm:text-2xl ${toneClass[s.tone ?? "default"]}`}
            >
              {s.to ? (
                // Lien étiré : son ::after couvre toute la case, la structure dt/dd reste valide.
                <Link
                  to={s.to}
                  className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-[inherit] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-[var(--primary)]"
                >
                  {s.value}
                </Link>
              ) : (
                s.value
              )}
            </dd>
            {s.hint ? <dd className="mt-1 truncate text-xs text-[var(--muted)]">{s.hint}</dd> : null}
          </>
        );
        return (
          <div
            key={s.label}
            className={`relative min-w-0 bg-[var(--surface)] p-4 sm:p-5 ${s.to ? "transition-colors hover:bg-[var(--surface-raised)]" : ""}`}
          >
            {content}
          </div>
        );
      })}
    </dl>
  );
}
