import { Link } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEnvelope } from "@fortawesome/free-solid-svg-icons";

type Props = {
  visible: boolean;
  onDismiss: () => void;
};

export function NewMailPill({ visible, onDismiss }: Props) {
  if (!visible) return null;

  return (
    <Link
      to="/inbox"
      onClick={onDismiss}
      className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full border border-[var(--border-strong)] bg-[var(--surface)] px-4 py-2.5 text-sm font-medium text-[var(--text)] shadow-lg ring-1 ring-black/5 transition hover:bg-[var(--surface-hover)]"
      aria-label="Voir les nouveaux messages"
    >
      <FontAwesomeIcon icon={faEnvelope} className="h-4 w-4 text-[var(--primary)]" />
      Nouveaux messages
    </Link>
  );
}
