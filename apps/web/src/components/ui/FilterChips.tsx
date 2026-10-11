export type FilterChipOption<T extends string> = {
  id: T;
  label: string;
  count?: number | null;
};

/**
 * Filtres exclusifs d'une liste (un seul actif). Une seule ligne défilante sur mobile,
 * état porté par aria-pressed et pas seulement par la couleur (fond + contour).
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
}: {
  options: ReadonlyArray<FilterChipOption<T>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`-mx-3 flex gap-1.5 overflow-x-auto px-3 no-scrollbar sm:mx-0 sm:flex-wrap sm:px-0 ${className}`}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            className={`inline-flex min-h-11 shrink-0 touch-manipulation items-center justify-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 sm:min-h-9 sm:px-3 ${
              active
                ? "border-[var(--primary)]/60 bg-[var(--primary-soft)] font-medium text-[var(--primary)]"
                : "border-[var(--border)] bg-[var(--surface)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            }`}
          >
            {o.label}
            {o.count != null ? (
              <span className="text-xs tabular-nums opacity-80">{o.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
