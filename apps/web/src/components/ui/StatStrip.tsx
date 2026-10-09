import type { ReactNode } from "react";

export type StatItem = {
  label: string;
  value: ReactNode;
  /** Ligne secondaire (contexte, échéance). */
  hint?: ReactNode;
  tone?: "default" | "primary" | "success" | "warning" | "danger";
};

const toneClass: Record<NonNullable<StatItem["tone"]>, string> = {
  default: "text-[var(--text)]",
  primary: "text-[var(--primary)]",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  danger: "text-[var(--danger)]",
};

/** Bandeau d'indicateurs dans une seule carte, séparés par des filets (2 colonnes en mobile). */
export function StatStrip({ items, className = "" }: { items: StatItem[]; className?: string }) {
  return (
    <dl
      className={`ui-card grid grid-cols-2 overflow-hidden ${
        items.length >= 4 ? "lg:grid-cols-4" : items.length === 3 ? "sm:grid-cols-3" : ""
      } ${className}`}
    >
      {items.map((s, i) => (
        <div
          key={s.label}
          className={`min-w-0 border-[var(--border)] p-4 sm:p-5 ${i % 2 === 1 ? "border-l" : ""} ${
            i >= 2 ? "border-t lg:border-t-0" : ""
          } ${items.length >= 4 && i % 4 !== 0 ? "lg:border-l" : ""}`}
        >
          <dt className="truncate text-xs font-medium text-[var(--muted)] sm:text-sm">{s.label}</dt>
          <dd className={`mt-1.5 font-display text-xl font-semibold tabular-nums tracking-tight sm:text-2xl ${toneClass[s.tone ?? "default"]}`}>
            {s.value}
          </dd>
          {s.hint ? <dd className="mt-1 truncate text-xs text-[var(--muted)]">{s.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}
