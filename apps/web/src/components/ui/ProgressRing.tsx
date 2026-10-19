/**
 * Anneau de progression (copie hors ligne, chargement long) : SVG, arc tracé par stroke-dasharray, pourcentage au
 * centre. role=progressbar avec aria-valuenow, aria-valuemin, aria-valuemax et un libellé. L'arc avance par
 * transition seulement si le mouvement est permis (motion-safe : rien sous prefers-reduced-motion).
 */
type Size = "sm" | "md" | "lg";

const SIZES: Record<Size, { box: string; stroke: number; text: string }> = {
  sm: { box: "size-8", stroke: 3, text: "text-[0.625rem]" },
  md: { box: "size-12", stroke: 4, text: "text-xs" },
  lg: { box: "size-20", stroke: 5, text: "text-base" },
};

const RADIUS = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function ProgressRing({
  value,
  max = 100,
  label,
  size = "md",
  showPercent = true,
  className = "",
}: {
  value: number;
  max?: number;
  /** Nom accessible (« Copie hors ligne, clients »). */
  label: string;
  size?: Size;
  showPercent?: boolean;
  className?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const ratio = Math.min(1, Math.max(0, value / safeMax));
  const percent = Math.round(ratio * 100);
  const s = SIZES[size];
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent} %`}
      className={`relative inline-flex shrink-0 items-center justify-center ${s.box} ${className}`}
    >
      <svg viewBox="0 0 40 40" className="size-full -rotate-90" aria-hidden>
        <circle cx="20" cy="20" r={RADIUS} fill="none" stroke="var(--border-strong)" strokeWidth={s.stroke} />
        <circle
          cx="20"
          cy="20"
          r={RADIUS}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={s.stroke}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-[var(--duration-fast)]"
        />
      </svg>
      {showPercent ? (
        <span className={`absolute inset-0 flex items-center justify-center font-semibold tabular-nums text-[var(--text)] ${s.text}`} aria-hidden>
          {size === "sm" ? percent : `${percent} %`}
        </span>
      ) : null}
    </span>
  );
}
