import { useId, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { faArrowDown, faArrowLeft, faArrowUp, faClockRotateLeft } from "@fortawesome/free-solid-svg-icons";
import { Link } from "react-router-dom";
import { useReadOnly } from "@/lib/offline/read-only";

const tones = {
  neutral: "bg-[var(--surface-raised)] text-[var(--muted)] ring-1 ring-[var(--border)]",
  teal: "bg-[var(--primary-soft)] text-[var(--primary)]",
  green: "bg-[var(--success-soft)] text-[var(--success)]",
  amber: "bg-[var(--warning-soft)] text-[var(--warning)]",
  red: "bg-[var(--danger-soft)] text-[var(--danger)]",
  blue: "bg-[var(--info-soft)] text-[var(--info)]",
  violet: "bg-[var(--accent-2-soft)] text-[var(--accent-2)]",
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
      className={`inline-flex items-center rounded-full px-2 py-1 text-[length:var(--text-badge)] leading-tight font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
  offlineActions,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Créations permises hors ligne (mises en file sur l'origine du hors ligne), après les autres actions. */
  offlineActions?: React.ReactNode;
  /** Lien de retour vers la liste parente (affiché au-dessus du titre). */
  back?: { to: string; label: string };
}) {
  // Hors ligne ou écran servi depuis la copie : date des données, et actions de l'en-tête désactivées.
  const { readOnly, copyNotice, reason, canPrepare } = useReadOnly();
  const noticeId = useId();
  return (
    <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0">
        {back ? (
          <Link
            to={back.to}
            className="-ml-1 mb-1 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-sm)] px-1 text-sm text-[var(--muted)] transition-colors hover:text-[var(--text)]"
          >
            <FontAwesomeIcon icon={faArrowLeft} className="h-3.5 w-3.5" aria-hidden />
            {back.label}
          </Link>
        ) : null}
        <h1 className="text-xl font-bold leading-tight tracking-tight text-[var(--text)] sm:text-2xl lg:text-3xl">
          {title}
        </h1>
        {subtitle ? (
          <div className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--muted)]">{subtitle}</div>
        ) : null}
        {copyNotice ? (
          <p id={noticeId} data-offline-notice className="mt-2 flex max-w-xl items-start gap-2 text-sm leading-snug text-[var(--warning)]">
            <FontAwesomeIcon icon={faClockRotateLeft} className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{copyNotice}</span>
          </p>
        ) : reason ? (
          // Hors ligne sans copie : le bandeau du haut l'affiche déjà ; ici pour les lecteurs d'écran, sans décaler la page.
          <span id={noticeId} className="sr-only">
            {reason}
          </span>
        ) : null}
      </div>
      {actions || offlineActions ? (
        // fieldset : un seul « disabled » coupe tous les boutons d'action de l'en-tête (les liens restent actifs).
        // Deux groupes en display: contents, pour que leurs boutons partagent la même rangée.
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:max-w-[min(100%,32rem)] sm:justify-end [&>fieldset>*]:flex-[1_1_8rem] sm:[&>fieldset>*]:flex-none">
          {actions ? (
            <fieldset disabled={readOnly} aria-describedby={reason ? noticeId : undefined} className="contents">
              {actions}
            </fieldset>
          ) : null}
          {offlineActions ? (
            <fieldset disabled={readOnly && !canPrepare} aria-describedby={reason ? noticeId : undefined} className="contents">
              {offlineActions}
            </fieldset>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Card({
  children,
  className = "",
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`ui-card ${className}`} {...rest}>
      {children}
    </div>
  );
}

const iconTones: Record<string, string> = {
  purple: "bg-[var(--accent-2-soft)] text-[var(--accent-2)]",
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
    <Card className={`min-w-0 p-3.5 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-2 sm:mb-4">
        <div
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] sm:h-10 sm:w-10 ${iconTones[iconTone]}`}
        >
          <FontAwesomeIcon icon={icon} className="h-4 w-4" />
        </div>
        {trend ? (
          <span
            className={`text-xs font-medium tabular-nums ${
              trendUp ? "text-[var(--success)]" : "text-[var(--danger)]"
            }`}
          >
            <FontAwesomeIcon icon={trendUp ? faArrowUp : faArrowDown} className="mr-1 h-3 w-3" aria-hidden />
            <span className="sr-only">{trendUp ? "en hausse : " : "en baisse : "}</span>
            {trend}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--muted)] sm:text-sm">{label}</p>
      <p className="mt-1 break-words text-lg font-bold tabular-nums tracking-tight text-[var(--text)] sm:text-2xl">
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
        <p className="text-xs text-[var(--muted)] sm:text-sm">{label}</p>
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
      <p className="text-xs text-[var(--muted)] sm:text-sm">{label}</p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-[var(--text)]">{value}</p>
    </Card>
  );
}

/** État vide : ce qui manque, et en option l'action qui le crée (ex. « Créer un pack »). */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="text-base font-medium text-[var(--text)]">{title}</p>
      {hint ? <p className="mt-1.5 text-sm text-[var(--muted)]">{hint}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
