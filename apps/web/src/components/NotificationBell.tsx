import { useEffect, useId, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell } from "@fortawesome/free-solid-svg-icons";
import { useNotifications } from "@/lib/notifications";
import { NOTIFICATION_KIND_STYLE as KIND } from "@/components/NotificationToast";

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/** Cloche de la barre supérieure : historique, non-lus, son et notifications du PC. */
export function NotificationBell() {
  const n = useNotifications();
  const [open, setOpen] = useState(false);
  const [testReport, setTestReport] = useState<string[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={n.unread > 0 ? `Notifications (${n.unread} non lues)` : "Notifications"}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      >
        <FontAwesomeIcon icon={faBell} className="h-4 w-4" aria-hidden />
        {n.unread > 0 ? (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[0.625rem] font-bold leading-none text-[var(--primary-fg)]">
            {n.unread > 9 ? "9+" : n.unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          id={panelId}
          // Sous 640 px : feuille du bas pleine largeur (sous la cloche, le panneau sortait à gauche de l'écran).
          className="fixed inset-x-0 bottom-0 z-50 overflow-hidden rounded-t-[var(--radius-lg)] border border-[var(--border-strong)] bg-[var(--surface-raised)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow)] sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:mt-2 sm:w-[min(24rem,calc(100vw-1.5rem))] sm:rounded-[var(--radius)] sm:pb-0"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            {n.unread > 0 ? (
              <button type="button" className="link min-h-11 text-sm" onClick={n.markAllRead}>
                Tout marquer comme lu
              </button>
            ) : null}
          </div>

          {n.items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--muted)]">Rien de nouveau sur les 7 derniers jours.</p>
          ) : (
            <ul className="custom-scrollbar max-h-[min(24rem,60vh)] divide-y divide-[var(--border)] overflow-y-auto">
              {n.items.map((item) => {
                const k = KIND[item.kind];
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        n.open(item);
                      }}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-[var(--surface-hover)]"
                    >
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${k.tone}`}>
                        <FontAwesomeIcon icon={k.icon} className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{item.title}</span>
                          {item.at > n.seenAt ? (
                            <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--primary)]" aria-label="non lue" />
                          ) : null}
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-xs text-[var(--muted)]">{item.body}</span>
                        <span className="mt-1 block text-xs text-[var(--muted)]">{ago(item.at)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="space-y-2 border-t border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-xs">
            <label className="flex min-h-11 items-center justify-between gap-3">
              <span>Son à chaque notification</span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--primary)]"
                checked={n.soundEnabled}
                onChange={(e) => n.setSoundEnabled(e.target.checked)}
              />
            </label>
            {n.desktopPermission === "unsupported" ? (
              <p className="text-[var(--muted)]">
                {typeof window !== "undefined" && !window.isSecureContext
                  ? "Notifications de l'appareil indisponibles sur cette adresse : ouvrez l'ERP par https://erp.kouzia.com."
                  : "Notifications de l'appareil indisponibles dans ce navigateur (iPhone : seulement dans l'application installée). Les nouveautés s'affichent ici tant que l'ERP est ouvert."}
              </p>
            ) : n.desktopPermission === "granted" ? (
              <p className="text-[var(--success)]">Notifications de l'appareil activées (ERP ouvert).</p>
            ) : n.desktopPermission === "denied" ? (
              <p className="text-[var(--muted)]">
                Notifications de l'appareil bloquées : autorisez-les dans les réglages du navigateur pour ce site.
              </p>
            ) : (
              <button
                type="button"
                className="min-h-11 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 text-left hover:bg-[var(--surface-hover)]"
                onClick={() => void n.requestDesktop()}
              >
                Activer les notifications de l'appareil
              </button>
            )}
            <button
              type="button"
              className="min-h-11 w-full rounded-[var(--radius-sm)] border border-[var(--border-strong)] px-3 text-left hover:bg-[var(--surface-hover)]"
              onClick={() => void n.testAlerts().then(setTestReport)}
            >
              Tester la notification et le son
            </button>
            {testReport ? (
              <ul role="status" className="list-disc space-y-0.5 pl-4 text-[var(--muted)]">
                {testReport.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
