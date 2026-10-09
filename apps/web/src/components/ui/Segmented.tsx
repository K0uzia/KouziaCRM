/** Choix exclusif compact (période, vue) : groupe de boutons à bascule. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
}: {
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] p-1 ${className}`}
    >
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            className={`min-h-9 flex-1 rounded-[calc(var(--radius-sm)-0.125rem)] px-3 text-sm transition-colors ${
              active
                ? "bg-[var(--surface-hover)] font-medium text-[var(--text)] shadow-[var(--shadow-sm)]"
                : "text-[var(--muted)] hover:text-[var(--text)]"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
