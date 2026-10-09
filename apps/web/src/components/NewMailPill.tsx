import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEnvelope } from "@fortawesome/free-solid-svg-icons";

type Props = {
  visible: boolean;
  unreadCount?: number;
  onDismiss: () => void;
};

export function NewMailPill({ visible, unreadCount = 0, onDismiss }: Props) {
  if (!visible) return null;

  const label =
    unreadCount > 0
      ? unreadCount === 1
        ? "1 nouveau message"
        : `${unreadCount} nouveaux messages`
      : "Nouveaux messages";

  return (
    <Link
      to="/inbox"
      onClick={onDismiss}
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-[var(--radius-lg)] border-2 border-[var(--primary)] bg-[var(--primary)] px-4 py-3 text-sm font-semibold text-[var(--primary-fg)] shadow-[var(--shadow)] transition hover:bg-[var(--primary-hover)] sm:bottom-[max(1.5rem,env(safe-area-inset-bottom))] sm:right-6 sm:px-5 sm:py-3.5"
      aria-label={label}
    >
      <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-[var(--primary-fg)]/15">
        <FontAwesomeIcon icon={faEnvelope} className="h-4 w-4" />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[0.625rem] font-bold leading-none text-[var(--bg)] ring-2 ring-[var(--primary)]">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </span>
      <span className="flex flex-col items-start leading-tight">
        <span>{label}</span>
        <span className="text-xs font-normal text-[var(--primary-fg)]/80">Ouvrir la boîte mail</span>
      </span>
    </Link>
  );
}
