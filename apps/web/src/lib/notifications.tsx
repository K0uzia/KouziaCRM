import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { isOnline, onReconnect } from "@/lib/network";
import { NotificationToast } from "@/components/NotificationToast";
import { shouldNotifySystem } from "@/lib/system-notify";

export type NotificationKind =
  | "mail"
  | "quote_accepted"
  | "quote_rejected"
  | "payment"
  | "deposit_due"
  | "subscription_stripe"
  | "client_onboarded"
  | "google_reauth"
  | "testimonial"
  | "software_request"
  | "email_review";

export type NotificationItem = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href: string;
  at: string;
  mail?: { from: string; subject: string; client: string | null };
};

type Feed = { items: NotificationItem[]; serverTime: string; seenAt: string };

// Chaque relevé est un aller-retour (par le tunnel en production) : 30 s, rien quand l'onglet est masqué.
const POLL_MS = 30_000;
const DATA_CHANGED = "kouzia:data-changed";
const SOUND_KEY = "kouzia.notifications.sound";

// Préférences légères du poste : stockage navigateur, protégé (navigation privée, quota).
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* préférence non persistée : sans conséquence */
  }
}

/** Petit carillon à deux notes, généré à la volée (aucun fichier audio). */
function useChime() {
  const ctxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    // L'audio n'est autorisé qu'après un geste. Le contexte peut aussi repasser en pause (onglet en
    // arrière-plan, changement de sortie audio) : chaque geste le relance, pas seulement le premier.
    const unlock = () => {
      if (!ctxRef.current) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctor) ctxRef.current = new Ctor();
      }
      if (ctxRef.current?.state === "suspended") void ctxRef.current.resume().catch(() => undefined);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  return useCallback((kind: NotificationKind): boolean => {
    const ctx = ctxRef.current;
    if (!ctx) return false;
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    if (ctx.state === "closed") return false;
    const notes = kind === "quote_rejected" ? [660, 494] : kind === "mail" ? [784, 988] : [659, 880, 1047];
    notes.forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
    return true;
  }, []);
}

type Ctx = {
  items: NotificationItem[];
  unread: number;
  /** Date de dernière lecture (ISO) : une notification plus récente est non lue. */
  seenAt: string;
  markAllRead: () => void;
  soundEnabled: boolean;
  setSoundEnabled: (v: boolean) => void;
  desktopPermission: NotificationPermission | "unsupported";
  requestDesktop: () => Promise<void>;
  /** Bouton « Tester » : joue le son et affiche une notification de l'appareil, renvoie le diagnostic. */
  testAlerts: () => Promise<string[]>;
  open: (item: NotificationItem) => void;
};

const NotificationsCtx = createContext<Ctx | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const chime = useChime();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [seenAt, setSeenAt] = useState<string>(() => new Date().toISOString());
  const [soundEnabled, setSoundState] = useState(() => readPref(SOUND_KEY) !== "off");
  // Hors https (LAN, Tailscale en http), le navigateur refuse toute notification : indisponible.
  const [desktopPermission, setDesktopPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" || !window.isSecureContext ? "unsupported" : Notification.permission,
  );
  const cursor = useRef<string | null>(null);
  const itemsRef = useRef<NotificationItem[]>([]);
  itemsRef.current = items;
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;

  const open = useCallback(
    (item: NotificationItem) => {
      navigate(item.href);
    },
    [navigate],
  );

  const announce = useCallback(
    (fresh: NotificationItem[]) => {
      // Au plus 3 toasts par vague, le reste est dans la cloche.
      fresh.slice(0, 3).forEach((item) => {
        toast.custom(
          (id) => (
            <NotificationToast
              item={item}
              onOpen={() => {
                toast.dismiss(id);
                navigate(item.href);
              }}
              onClose={() => toast.dismiss(id)}
            />
          ),
          { id: item.id, duration: 8000, unstyled: true },
        );
      });
      if (soundRef.current) chime(fresh[0].kind);
      // Notification de l'appareil seulement ERP hors de l'écran : à l'écran, le toast suffit (pas de doublon).
      if (shouldNotifySystem()) {
        fresh.slice(0, 3).forEach((item) => {
          // Android Chrome interdit new Notification() dans une page (service worker requis) :
          // l'exception ne doit pas interrompre les toasts ni le rechargement des écrans.
          try {
            const n = new Notification(item.title, { body: item.body, tag: item.id, icon: "/favicon.svg" });
            n.onclick = () => {
              window.focus();
              navigate(item.href);
              n.close();
            };
          } catch {
            /* notification de l'appareil indisponible ici : toast et cloche suffisent */
          }
        });
      }
    },
    [chime, navigate],
  );

  useEffect(() => {
    let cancelled = false;

    async function first() {
      const feed = await api<Feed>("/api/notifications/feed");
      if (cancelled) return;
      setItems(feed.items);
      setSeenAt(feed.seenAt);
      cursor.current = feed.serverTime;
    }

    async function poll() {
      // Hors ligne : relevé en pause, repris par onReconnect.
      if (!cursor.current || document.visibilityState === "hidden" || !isOnline()) return;
      const feed = await api<Feed>(`/api/notifications/feed?since=${encodeURIComponent(cursor.current)}`);
      if (cancelled) return;
      cursor.current = feed.serverTime;
      // Lu sur un autre appareil : le compteur suit.
      setSeenAt((prev) => (feed.seenAt > prev ? feed.seenAt : prev));
      if (feed.items.length === 0) return;
      const known = new Set(itemsRef.current.map((i) => i.id));
      const fresh = feed.items.filter((i) => !known.has(i.id));
      if (fresh.length === 0) return;
      itemsRef.current = [...fresh, ...itemsRef.current].slice(0, 50);
      setItems(itemsRef.current);
      announce(fresh);
      // Les écrans ouverts se rechargent (devis accepté, paiement reçu…) sans action de l'utilisateur.
      window.dispatchEvent(new CustomEvent<NotificationItem[]>(DATA_CHANGED, { detail: fresh }));
    }

    first().catch(() => undefined);
    const id = setInterval(() => void poll().catch(() => undefined), POLL_MS);
    // Retour sur l'onglet : rattrapage immédiat plutôt qu'au prochain cycle.
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    // Retour du réseau : rattrapage immédiat (ou premier chargement, s'il avait échoué).
    const stopReconnect = onReconnect(() => void (cursor.current ? poll() : first()).catch(() => undefined));
    return () => {
      cancelled = true;
      clearInterval(id);
      stopReconnect();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [announce]);

  const value = useMemo<Ctx>(
    () => ({
      items,
      seenAt,
      unread: items.filter((i) => i.at > seenAt).length,
      markAllRead: () => {
        // Lecture enregistrée en base, commune au PC et au téléphone.
        setSeenAt(new Date().toISOString());
        void api<{ seenAt: string }>("/api/notifications/seen", { method: "POST", body: "{}" })
          .then((r) => setSeenAt(r.seenAt))
          .catch(() => undefined);
        // L'état lu des e-mails vit en base (une seule source) : les messages notifiés y passent lus,
        // puis les écrans ouverts (carte du tableau de bord, messagerie) se rechargent.
        const messageIds = items.filter((i) => i.kind === "mail").map((i) => i.id.replace(/^mail:/, ""));
        if (messageIds.length > 0) {
          void api("/api/emails/messages/bulk-flags", {
            method: "POST",
            body: JSON.stringify({ messageIds, read: true }),
          })
            .then(() => window.dispatchEvent(new CustomEvent<NotificationItem[]>(DATA_CHANGED, { detail: [] })))
            .catch(() => undefined);
        }
      },
      soundEnabled,
      setSoundEnabled: (v) => {
        setSoundState(v);
        writePref(SOUND_KEY, v ? "on" : "off");
      },
      desktopPermission,
      requestDesktop: async () => {
        if (typeof Notification === "undefined") return;
        const result = await Notification.requestPermission();
        setDesktopPermission(result);
        if (result === "granted") {
          try {
            new Notification("Notifications activées", {
              body: "Vous serez prévenu des nouveaux messages, devis et paiements.",
              icon: "/favicon.svg",
            });
          } catch {
            // Permission accordée mais affichage impossible dans une page (Android) : signalé comme indisponible.
            setDesktopPermission("unsupported");
          }
        }
      },
      testAlerts: async () => {
        const report: string[] = [];
        report.push(
          !soundEnabled
            ? "Son désactivé dans ce panneau."
            : chime("mail")
              ? "Son joué (vérifiez le volume de l'ordinateur et de l'onglet)."
              : "Son indisponible : cliquez une fois dans la page puis réessayez.",
        );
        if (typeof Notification === "undefined") {
          report.push("Ce navigateur ne gère pas les notifications.");
        } else if (!window.isSecureContext) {
          report.push("Notifications impossibles hors https : ouvrez l'ERP par son adresse https.");
        } else {
          let permission = Notification.permission;
          if (permission === "default") {
            permission = await Notification.requestPermission();
            setDesktopPermission(permission);
          }
          if (permission === "granted") {
            try {
              new Notification("Test Kouzia", { body: "Les notifications de l'appareil fonctionnent.", icon: "/favicon.svg", tag: "kouzia-test" });
              report.push("Notification envoyée. Si rien ne s'affiche, vérifiez les réglages Windows (Notifications, mode Ne pas déranger).");
            } catch {
              setDesktopPermission("unsupported");
              report.push("Ce navigateur bloque les notifications dans une page : activez les notifications push dans Réglages > Notifications.");
            }
          } else {
            report.push("Notifications refusées pour ce site : autorisez-les dans les réglages du navigateur (cadenas, Notifications).");
          }
        }
        return report;
      },
      open,
    }),
    [items, seenAt, soundEnabled, desktopPermission, open, chime],
  );

  return <NotificationsCtx.Provider value={value}>{children}</NotificationsCtx.Provider>;
}

export function useNotifications(): Ctx {
  const ctx = useContext(NotificationsCtx);
  if (!ctx) throw new Error("useNotifications hors NotificationsProvider");
  return ctx;
}

/**
 * Recharge un écran quand le centre de notifications signale un changement qui le concerne.
 * `match` filtre les événements (par défaut : tous).
 */
export function useLiveRefresh(reload: () => void, match?: (item: NotificationItem) => boolean) {
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const matchRef = useRef(match);
  matchRef.current = match;
  useEffect(() => {
    const onChange = (e: Event) => {
      const items = (e as CustomEvent<NotificationItem[]>).detail ?? [];
      if (!matchRef.current || items.some((i) => matchRef.current!(i))) reloadRef.current();
    };
    window.addEventListener(DATA_CHANGED, onChange);
    return () => window.removeEventListener(DATA_CHANGED, onChange);
  }, []);
}
