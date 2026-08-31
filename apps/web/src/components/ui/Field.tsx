import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";

export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      <span className="text-sm font-medium text-[var(--text)]">{label}</span>
      {children}
      {hint && !error ? <span className="block text-xs text-[var(--muted)]">{hint}</span> : null}
      {error ? <span className="block text-xs text-[var(--danger)]">{error}</span> : null}
    </label>
  );
}

const control =
  "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--muted)] transition focus:border-[var(--primary)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/20 disabled:bg-[var(--bg-subtle)] disabled:opacity-70";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${control} ${props.className ?? ""}`} {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${control} ${props.className ?? ""}`} {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${control} min-h-[96px] resize-y ${props.className ?? ""}`} {...props} />;
}
