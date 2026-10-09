import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const styles: Record<Variant, string> = {
  primary: "btn-accent shadow-[var(--shadow-sm)]",
  secondary:
    "bg-[var(--surface-raised)] text-[var(--text)] border-[var(--border-strong)] hover:bg-[var(--surface-hover)]",
  ghost:
    "bg-transparent text-[var(--muted)] border-transparent hover:bg-[var(--surface-hover)] hover:text-[var(--text)]",
  danger:
    "bg-[var(--danger-soft)] text-[var(--danger)] border-[var(--danger)]/30 hover:bg-[var(--danger)]/20",
};

const base =
  "inline-flex min-h-11 min-w-11 shrink-0 touch-manipulation items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius)] border px-4 text-sm font-medium transition-colors duration-150";

export function buttonClass(variant: Variant = "primary", className = ""): string {
  return `${base} ${styles[variant]} ${className}`;
}

export function Button({
  variant = "primary",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={buttonClass(variant, `disabled:cursor-not-allowed disabled:opacity-50 ${className}`)}
      {...props}
    >
      {children}
    </button>
  );
}

/** Navigation présentée comme un bouton : un seul élément focalisable (pas de bouton dans un lien). */
export function ButtonLink({
  variant = "primary",
  className = "",
  children,
  ...props
}: LinkProps & { variant?: Variant; children: ReactNode }) {
  return (
    <Link className={buttonClass(variant, className)} {...props}>
      {children}
    </Link>
  );
}
