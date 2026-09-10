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
      className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-[var(--radius-lg)] border-2 border-[var(--primary)] bg-[var(--primary)] px-5 py-3.5 text-sm font-semibold text-white shadow-[0_12px_40px_-8px_rgba(0,0,0,0.35)] transition hover:brightness-110 animate-[pulse_2s_ease-in-out_infinite]"
      aria-label={label}
    >
      <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-white/20">
        <FontAwesomeIcon icon={faEnvelope} className="h-4 w-4" />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[10px] font-bold leading-none text-white ring-2 ring-[var(--primary)]">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </span>
      <span className="flex flex-col items-start leading-tight">
        <span>{label}</span>
        <span className="text-xs font-normal text-white/80">Ouvrir la boîte mail</span>
      </span>
    </Link>
  );
}
