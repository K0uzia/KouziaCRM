import type { ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

const tones = {
  neutral: "bg-[var(--surface-raised)] text-[var(--muted)] ring-1 ring-[var(--border)]",
  teal: "bg-[var(--primary-soft)] text-[var(--primary)]",
  green: "bg-[var(--success-soft)] text-[var(--success)]",
  amber: "bg-[var(--warning-soft)] text-[var(--warning)]",
  red: "bg-[var(--danger-soft)] text-[var(--danger)]",
  blue: "bg-[var(--info-soft)] text-[var(--info)]",
  violet: "bg-[var(--primary-soft)] text-[var(--primary)]",
} as const;

export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: keyof typeof tones;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold leading-tight tracking-tight text-[var(--text)] sm:text-3xl">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--muted)]">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 sm:max-w-[min(100%,28rem)] sm:justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`glass-card ${className}`}>
      {children}
    </div>
  );
}

const iconTones: Record<string, string> = {
  purple: "bg-[var(--primary-soft)] text-[var(--primary)]",
  green: "bg-[var(--success-soft)] text-[var(--success)]",
  blue: "bg-[var(--info-soft)] text-[var(--info)]",
  orange: "bg-[var(--orange-soft)] text-[var(--orange)]",
  neutral: "bg-[var(--surface-hover)] text-[var(--muted)]",
};

/** Carte KPI style Dribbble : icône, trend, label, grande valeur */
export function KpiCard({
  label,
  value,
  icon,
  iconTone = "purple",
  trend,
  trendUp = true,
  hint,
  footer,
  className = "",
}: {
  label: string;
  value: ReactNode;
  icon: IconDefinition;
  iconTone?: keyof typeof iconTones;
  trend?: string;
  trendUp?: boolean;
  hint?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`p-5 ${className}`}>
      <div className="mb-4 flex items-start justify-between gap-2">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-sm)] ${iconTones[iconTone]}`}
        >
          <FontAwesomeIcon icon={icon} className="h-4 w-4" />
        </div>
        {trend ? (
          <span
            className={`text-xs font-medium tabular-nums ${
              trendUp ? "text-[var(--success)]" : "text-[var(--danger)]"
            }`}
          >
            {trendUp ? "↑" : "↓"} {trend}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-[var(--muted)]">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-[var(--text)] sm:text-[1.75rem]">
        {value}
      </p>
      {hint ? <p className="mt-2 text-xs text-[var(--muted)]">{hint}</p> : null}
      {footer ? <div className="mt-2">{footer}</div> : null}
    </Card>
  );
}

/** Ligne stat compacte (panneau latéral style Dribbble) */
export function StatRow({
  icon,
  label,
  value,
  iconTone = "blue",
}: {
  icon: IconDefinition;
  label: string;
  value: ReactNode;
  iconTone?: keyof typeof iconTones;
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] ${iconTones[iconTone]}`}
      >
        <FontAwesomeIcon icon={icon} className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-[var(--muted)]">{label}</p>
        <p className="font-semibold tabular-nums text-[var(--text)]">{value}</p>
      </div>
    </div>
  );
}

/** @deprecated Utiliser KpiCard */
export function StatCard({
  label,
  value,
  className = "",
}: {
  label: string;
  value: ReactNode;
  accent?: string;
  className?: string;
}) {
  return (
    <Card className={`p-5 ${className}`}>
      <p className="text-sm text-[var(--muted)]">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-[var(--text)]">{value}</p>
    </Card>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="text-base font-medium text-[var(--text)]">{title}</p>
      {hint ? <p className="mt-1.5 text-sm text-[var(--muted)]">{hint}</p> : null}
    </div>
  );
}
