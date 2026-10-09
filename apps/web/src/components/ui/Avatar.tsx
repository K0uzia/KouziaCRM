/** Initiales d'un client ou d'un contact (décoratif : le nom est toujours affiché à côté). */
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  const initials =
    name
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .split(/[\s-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "?";
  const dims = { sm: "h-8 w-8 text-xs", md: "h-9 w-9 text-sm", lg: "h-14 w-14 text-lg" }[size];
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--surface-raised)] font-display font-semibold text-[var(--primary)] ${dims}`}
    >
      {initials}
    </span>
  );
}
