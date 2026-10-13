import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faCircleCheck,
  faCircleXmark,
  faEnvelope,
  faFileInvoiceDollar,
  faRotate,
  faUserPlus,
  faWallet,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import type { NotificationItem, NotificationKind } from "@/lib/notifications";

/** Icône et teinte par type : une seule source pour la cloche et les notifications en app. */
export const NOTIFICATION_KIND_STYLE: Record<NotificationKind, { icon: IconDefinition; tone: string }> = {
  mail: { icon: faEnvelope, tone: "bg-[var(--info-soft)] text-[var(--info)]" },
  quote_accepted: { icon: faCircleCheck, tone: "bg-[var(--success-soft)] text-[var(--success)]" },
  quote_rejected: { icon: faCircleXmark, tone: "bg-[var(--danger-soft)] text-[var(--danger)]" },
  payment: { icon: faWallet, tone: "bg-[var(--success-soft)] text-[var(--success)]" },
  deposit_due: { icon: faFileInvoiceDollar, tone: "bg-[var(--warning-soft)] text-[var(--warning)]" },
  client_onboarded: { icon: faUserPlus, tone: "bg-[var(--success-soft)] text-[var(--success)]" },
  subscription_stripe: { icon: faRotate, tone: "bg-[var(--warning-soft)] text-[var(--warning)]" },
};

/**
 * Notification en app (toast sonner sans style par défaut), aux couleurs Kouzia.
 * E-mail : expéditeur en gras, objet sur deux lignes au plus, client rattaché.
 * Annoncée par la région live de sonner (role status), sans prendre le focus.
 */
export function NotificationToast({
  item,
  onOpen,
  onClose,
}: {
  item: NotificationItem;
  onOpen: () => void;
  onClose: () => void;
}) {
  const style = NOTIFICATION_KIND_STYLE[item.kind];
  const mail = item.kind === "mail" ? item.mail : undefined;
  return (
    <div
      role="status"
      className="flex w-[min(24rem,calc(100vw-2rem))] gap-3 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--text)] shadow-[var(--shadow)]"
    >
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${style.tone}`}>
        <FontAwesomeIcon icon={style.icon} className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        {mail ? (
          <>
            <p className="truncate font-semibold">{mail.from}</p>
            <p className="line-clamp-2 text-[var(--text)]">{mail.subject || "(sans objet)"}</p>
            {mail.client ? <p className="mt-0.5 truncate text-xs text-[var(--muted)]">Client : {mail.client}</p> : null}
          </>
        ) : (
          <>
            <p className="font-semibold">{item.title}</p>
            <p className="line-clamp-2 text-[var(--text)]">{item.body}</p>
          </>
        )}
        <button
          type="button"
          onClick={onOpen}
          className="mt-1 inline-flex min-h-11 items-center rounded-[var(--radius-sm)] font-semibold text-[var(--primary)] underline-offset-2 hover:underline"
        >
          Ouvrir
        </button>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Fermer la notification"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
