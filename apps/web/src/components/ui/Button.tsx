import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const styles: Record<Variant, string> = {
  primary:
    "bg-[var(--primary)] text-white hover:bg-[var(--primary-hover)] border-transparent",
  secondary:
    "bg-white text-[var(--text)] border-[var(--border-strong)] hover:bg-[var(--bg)]",
  ghost: "bg-transparent text-[var(--muted)] border-transparent hover:bg-[var(--bg)] hover:text-[var(--text)]",
  danger: "bg-[var(--danger-soft)] text-[var(--danger)] border-transparent hover:bg-red-100",
};

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
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-[var(--radius)] border px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
