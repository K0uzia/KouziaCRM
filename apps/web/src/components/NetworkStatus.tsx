import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPlugCircleXmark, faWifi } from "@fortawesome/free-solid-svg-icons";
import { OFFLINE_TOAST_ID, useOnline } from "@/lib/network";
import { offlineEnabled } from "@/lib/offline/config";
import { useOfflineQueue } from "@/lib/offline/queue";

const BACK_ONLINE_MS = 3000;

/**
 * Bandeau réseau de la barre du haut : « Hors ligne · N à envoyer » pendant la coupure (créations mises en file,
 * origine du hors ligne ; ailleurs « Hors ligne · consultation seule »), « De nouveau en ligne » 3 s au retour.
 * À placer juste sous la barre, dans un conteneur relatif de hauteur nulle : à cheval sur le filet, hors du flux,
 * aucun décalage de la mise en page.
 * La région role=status reste montée, vide en ligne, pour que le changement soit annoncé.
 */
export function NetworkStatus() {
  const online = useOnline();
  const { items } = useOfflineQueue();
  const queued = offlineEnabled() ? items.length : 0;
  // « N à envoyer » : lien vers l'écran à partir de 768 px (souris, tablette) ; en dessous, le lien de 44 px est
  // dans la barre du haut (ou le menu sous 400 px), le bandeau garde le texte seul. Cible de 24 px (WCAG 2.5.8).
  const offlineLabel = !offlineEnabled() ? (
    "Hors ligne · consultation seule"
  ) : queued ? (
    <>
      Hors ligne ·{" "}
      <span className="md:hidden">{queued} à envoyer</span>
      <Link to="/a-envoyer" className="pointer-events-auto -my-1 hidden min-h-6 items-center underline underline-offset-2 hover:text-[var(--primary)] md:inline-flex">
        {queued} à envoyer
      </Link>
    </>
  ) : (
    "Hors ligne"
  );
  const [backOnline, setBackOnline] = useState(false);
  const wasOffline = useRef(!online);

  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setBackOnline(false);
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    toast.dismiss(OFFLINE_TOAST_ID);
    setBackOnline(true);
    const timer = window.setTimeout(() => setBackOnline(false), BACK_ONLINE_MS);
    return () => window.clearTimeout(timer);
  }, [online]);

  const visible = !online || backOnline;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute left-1/2 top-0 z-40 -translate-x-1/2 -translate-y-1/2"
    >
      {visible ? (
        <span
          data-network-status={online ? "online" : "offline"}
          className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-[var(--border-strong)] px-3 py-1 text-xs font-medium text-[var(--text)] bg-[var(--surface-raised)] shadow-[var(--shadow-sm)]"
        >
          <FontAwesomeIcon
            icon={online ? faWifi : faPlugCircleXmark}
            className={`h-3 w-3 ${online ? "text-[var(--success)]" : "text-[var(--warning)]"}`}
            aria-hidden
          />
          {online ? "De nouveau en ligne" : offlineLabel}
        </span>
      ) : null}
    </div>
  );
}
