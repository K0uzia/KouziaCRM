const tones = {
  neutral: "bg-gray-100 text-gray-700",
  teal: "bg-[var(--primary-soft)] text-[var(--primary)]",
  green: "bg-[var(--success-soft)] text-[var(--success)]",
  amber: "bg-[var(--warning-soft)] text-[var(--warning)]",
  red: "bg-[var(--danger-soft)] text-[var(--danger)]",
  blue: "bg-sky-50 text-sky-700",
  violet: "bg-violet-50 text-violet-700",
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
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p>
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
    <div
      className={`rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)] ${className}`}
    >
      {children}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="text-sm font-medium text-[var(--text)]">{title}</p>
      {hint ? <p className="mt-1 text-sm text-[var(--muted)]">{hint}</p> : null}
    </div>
  );
}
