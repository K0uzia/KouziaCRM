import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBars,
  faBriefcase,
  faCloudArrowUp,
  faGlobe,
  faEllipsis,
  faMagnifyingGlass,
  faPlus,
  faRightFromBracket,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import { useAuth } from "@/lib/auth";
// Palette Ctrl K (cmdk, Radix Dialog) hors du chunk d'entrée : chargée au premier usage, ou en
// tâche de fond une fois la page affichée.
const loadCommandPalette = () => import("@/components/CommandPalette");
const CommandPalette = optionalLazy(() => loadCommandPalette().then((m) => m.CommandPalette));
import { NotificationBell } from "@/components/NotificationBell";
import { NetworkStatus } from "@/components/NetworkStatus";
import { PageErrorBoundary } from "@/components/PageErrorBoundary";
import { optionalLazy } from "@/components/OptionalLazy";
import { useReadOnly } from "@/lib/offline/read-only";
import { offlineEnabled } from "@/lib/offline/config";
import { getQueueSnapshot, itemsLabel, replayQueue, useOfflineQueue } from "@/lib/offline/queue";
import { usePendingSoftwareRequests } from "@/lib/software-requests";
import { isOnline } from "@/lib/network";
import { apiInflight } from "@/lib/api";
import { startReconnectRefresh } from "@/lib/reconnect";
import { toast } from "sonner";
import { NotificationsProvider } from "@/lib/notifications";
import { VersionNotice } from "@/components/VersionNotice";
import { OfflineCopyIndicator } from "@/components/OfflineCopyIndicator";
import { OfflinePageMissing } from "@/components/OfflinePageMissing";
import { forgetMissing, usePageMissing } from "@/lib/offline/served";
import { copyNow, startAutoOfflineCopy } from "@/lib/offline/sync";
import { MoreMenu } from "@/components/ui/MoreMenu";

// Publication du site : seulement dans l'espace Site, chargé à la demande.
const SitePublishBar = optionalLazy(() => import("@/components/site/SitePublishBar").then((m) => m.default));
import { useNewMailAlert } from "@/hooks/useNewMailAlert";
import {
  filterSections,
  findNavItem,
  locate,
  NAV_SPACES,
  SETTINGS_ITEM,
  spaceOf,
  type NavItem,
  type NavSpaceId,
} from "@/lib/navigation";
import { useFeatures } from "@/lib/features";

const isSpaceHome = (to: string) => NAV_SPACES.some((s) => s.home === to);

function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`shrink-0 ${className}`} aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--surface-raised)" />
      <path
        d="M10 7v18M10 17l9-10M13 14l7 11"
        stroke="var(--primary)"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--primary)] px-1.5 text-[0.6875rem] font-semibold leading-5 text-[var(--primary-fg)] tabular-nums">
      {count > 99 ? "99+" : count}
    </span>
  );
}

const SPACE_ICONS = { gestion: faBriefcase, site: faGlobe } as const;

/**
 * Bascule entre les espaces Gestion et Site : une navigation (des liens, l'URL porte l'espace), pas deux boutons.
 * Piste en creux et espace actif en relief, teinté ambre, en gras et avec un trait : l'état ne tient pas à la seule
 * couleur ; l'autre espace reste un lien discret.
 */
function SpaceSwitch({ current }: { current: NavSpaceId }) {
  return (
    <nav aria-label="Espace" className="shrink-0 px-3 pb-2">
      <ul className="grid grid-cols-2 gap-1 rounded-[var(--radius)] bg-[var(--bg-subtle)] p-1">
        {NAV_SPACES.map((space) => {
          const active = space.id === current;
          return (
            <li key={space.id}>
              <Link
                to={space.home}
                aria-current={active ? "true" : undefined}
                className={`relative flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-sm)] px-3 text-sm transition-colors ${
                  active
                    ? "bg-[var(--primary-soft)] font-semibold text-[var(--primary)] after:absolute after:inset-x-4 after:bottom-1 after:h-0.5 after:rounded-full after:bg-[var(--primary)]"
                    : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                }`}
              >
                <FontAwesomeIcon icon={SPACE_ICONS[space.id]} className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {space.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Envoi de la file des créations hors ligne depuis la page : à l'ouverture de l'ERP, au retour du réseau, et
 * toutes les 30 s tant qu'il reste à envoyer (serveur injoignable sans coupure du réseau, donc sans événement
 * online). Jamais par Background Sync. Session refusée : l'ERP repasse par la connexion, la file attend.
 */
/** Envoi de la file : à l'ouverture, toutes les 30 s s'il reste à envoyer ; au retour du réseau par lib/reconnect. */
function useQueueReplay(onSessionExpired: () => void): () => Promise<void> {
  const runRef = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    if (!offlineEnabled()) return;
    const run = async () => {
      if (!isOnline()) return;
      const before = getQueueSnapshot();
      const signals = before.signals.length;
      const status = await replayQueue({ onSessionExpired });
      const after = getQueueSnapshot();
      const sent = before.items.length - after.items.length;
      if (sent > 0) toast.success(`${itemsLabel(sent)} préparé${sent > 1 ? "s" : ""} hors ligne envoyé${sent > 1 ? "s" : ""}.`);
      if (after.signals.length > signals) toast.warning("Créé avec un écart à relire : voir « À envoyer ».");
      if (status === "done" && after.items.some((i) => i.state === "review")) toast.warning("Des éléments sont à revoir : voir « À envoyer ».");
    };
    runRef.current = run;
    void run();
    const timer = window.setInterval(() => {
      if (getQueueSnapshot().items.some((i) => i.state !== "review")) void run();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [onSessionExpired]);
  return useCallback(() => runRef.current(), []);
}

/** Lien de la barre latérale : icône, libellé, compteur, état actif (barre d'accent + fond). */
function SideLink({
  item,
  active,
  unread,
  queued = 0,
  requests = 0,
}: {
  item: NavItem;
  active: boolean;
  unread: number;
  queued?: number;
  requests?: number;
}) {
  return (
    <NavLink
      to={item.to}
      end={isSpaceHome(item.to)}
      aria-current={active ? "page" : undefined}
      className={`group relative flex min-h-10 items-center gap-3 rounded-[var(--radius-sm)] px-3 text-sm transition-colors ${
        active
          ? "bg-[var(--primary-soft)] font-medium text-[var(--text)]"
          : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
      }`}
    >
      {active ? (
        <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-[var(--primary)]" aria-hidden />
      ) : null}
      <FontAwesomeIcon
        icon={item.icon}
        className={`h-4 w-4 shrink-0 ${active ? "text-[var(--primary)]" : ""}`}
        aria-hidden
      />
      <span className="min-w-0 truncate">{item.label}</span>
      {item.badge === "unread" ? <UnreadBadge count={unread} /> : null}
      {item.badge === "queue" ? <UnreadBadge count={queued} /> : null}
      {item.badge === "requests" ? <UnreadBadge count={requests} /> : null}
    </NavLink>
  );
}

function Sidebar({
  pathname,
  unread,
  onLogout,
  userLabel,
}: {
  pathname: string;
  unread: number;
  onLogout: () => void;
  userLabel: string;
}) {
  const features = useFeatures();
  const space = spaceOf(pathname);
  const sections = filterSections(space.sections, features, offlineEnabled());
  const { items: queued } = useOfflineQueue();
  const requests = usePendingSoftwareRequests();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link to="/" className="flex h-[var(--topbar-h)] shrink-0 items-center gap-2.5 px-5" aria-label="Kouzia ERP, tableau de bord">
        <BrandMark />
        <span className="font-display text-lg font-semibold tracking-wide text-[var(--text)]">
          Kouzia <span className="text-[var(--primary)]">ERP</span>
        </span>
      </Link>
      <SpaceSwitch current={space.id} />
      <nav aria-label={`Navigation : ${space.label}`} className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {sections.map((section) => (
          <div key={section.id} className="mt-4 first:mt-1">
            {section.label ? (
              <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--muted)]">
                {section.label}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.id}>
                  <SideLink item={item} active={item.match(pathname)} unread={unread} queued={queued.length} requests={requests} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="shrink-0 space-y-0.5 border-t border-[var(--border)] p-3">
        <SideLink item={SETTINGS_ITEM} active={SETTINGS_ITEM.match(pathname)} unread={0} />
        <button
          type="button"
          onClick={onLogout}
          className="flex min-h-10 w-full items-center gap-3 rounded-[var(--radius-sm)] px-3 text-sm text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
        >
          <FontAwesomeIcon icon={faRightFromBracket} className="h-4 w-4" aria-hidden />
          <span className="min-w-0 truncate">Se déconnecter</span>
        </button>
        {userLabel ? (
          <p className="truncate px-3 pt-1 text-xs text-[var(--muted)]" title={userLabel}>
            {userLabel}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AppLayout() {
  const { logout, user, refresh } = useAuth();
  // Option « effacer à la déconnexion » : copie gardée tant que des créations hors ligne restent à envoyer.
  const onLogout = () =>
    void logout().then((outcome) => {
      if (outcome === "kept-pending") toast.warning("Copie hors ligne gardée : des créations préparées hors ligne restent à envoyer.");
    });
  const replay = useQueueReplay(refresh);
  // Copie hors ligne complète puis tenue à jour (origine du hors ligne seulement) : lib/offline/sync.
  useEffect(() => startAutoOfflineCopy(), []);
  // Retour du réseau : file envoyée, écran affiché remonté (ses données relues, défilement gardé), copie mise à jour.
  // Double tampon : le nouvel écran se monte caché et relit ses données ; il remplace l'ancien d'un coup quand ses
  // requêtes sont finies (300 ms sans requête, 8 s au plus). Pas de squelette ni de décalage de mise en page (CLS).
  const [pageEpoch, setPageEpoch] = useState(0);
  const [nextEpoch, setNextEpoch] = useState<number | null>(null);
  const swapped = useRef<(() => void) | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(
    () =>
      startReconnectRefresh({
        replay,
        remountPage: () =>
          new Promise<void>((resolve) => {
            forgetMissing(window.location.pathname);
            swapped.current = resolve;
            setNextEpoch(Date.now());
          }),
        copy: () => (offlineEnabled() ? copyNow() : Promise.resolve(null)),
      }),
    [replay],
  );
  useEffect(() => {
    if (nextEpoch === null) return;
    const started = Date.now();
    let quietSince = 0;
    const timer = window.setInterval(() => {
      quietSince = apiInflight() === 0 ? quietSince || Date.now() : 0;
      if ((quietSince && Date.now() - quietSince >= 300) || Date.now() - started > 8000) {
        window.clearInterval(timer);
        const top = mainRef.current?.scrollTop ?? 0;
        setPageEpoch(nextEpoch);
        setNextEpoch(null);
        requestAnimationFrame(() => mainRef.current?.scrollTo({ top }));
        swapped.current?.();
        swapped.current = null;
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [nextEpoch]);
  const { items: queuedItems } = useOfflineQueue();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { readOnly, reason, canPrepare } = useReadOnly();
  const readOnlyId = useId();
  const [paletteUsed, setPaletteUsed] = useState(false);
  useEffect(() => {
    if (paletteOpen) setPaletteUsed(true);
  }, [paletteOpen]);
  useEffect(() => {
    const id = setTimeout(() => void loadCommandPalette().catch(() => undefined), 3000);
    return () => clearTimeout(id);
  }, []);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  // Bouton qui a ouvert le tiroir (menu de la barre supérieure ou « Plus » de la barre du bas).
  const drawerOpener = useRef<HTMLElement | null>(null);
  const openDrawer = (e: { currentTarget: HTMLElement }) => {
    drawerOpener.current = e.currentTarget;
    setDrawerOpen(true);
  };
  // Après le rendu : tant que le tiroir est ouvert, le bouton est inerte et refuse le focus.
  const returnFocus = () =>
    requestAnimationFrame(() => (drawerOpener.current ?? drawerTrigger.current)?.focus());
  const drawerRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  // Hors ligne, écran sans aucune donnée sur l'appareil : état propre ; l'écran reste monté (caché) pour réessayer.
  const pageMissing = usePageMissing(pathname) && readOnly;
  const features = useFeatures();
  const space = spaceOf(pathname);
  const { item: current, section: currentSection } = locate(pathname);
  const { unreadCount } = useNewMailAlert();
  const isMailWorkspace =
    pathname === "/inbox" ||
    (pathname.startsWith("/inbox/") && !pathname.startsWith("/inbox/compose"));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Navigation depuis le tiroir : il se ferme, puis le focus va au contenu de la nouvelle page
  // (sinon il tomberait sur body, le lien cliqué ayant disparu).
  const focusMainAfterNav = useRef(false);
  const drawerOpenNow = useRef(drawerOpen);
  drawerOpenNow.current = drawerOpen;
  useEffect(() => {
    if (drawerOpenNow.current) focusMainAfterNav.current = true;
    setDrawerOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (drawerOpen || !focusMainAfterNav.current) return;
    focusMainAfterNav.current = false;
    // Après le rendu sans inert : un élément inerte ne prend pas le focus.
    requestAnimationFrame(() => document.getElementById("contenu")?.focus({ preventScroll: true }));
  }, [drawerOpen]);

  useEffect(() => {
    document.title = current ? `${current.label} · Kouzia ERP` : "Kouzia ERP";
  }, [current]);

  // Accent de l'espace (tokens redéfinis sous [data-space] dans index.css) : sur la racine, pour
  // que les toasts et tout ce qui sort de cette arborescence le prennent aussi.
  useEffect(() => {
    document.documentElement.dataset.space = space.id;
    return () => {
      delete document.documentElement.dataset.space;
    };
  }, [space.id]);

  // Tiroir mobile (dialogue modal) : focus dedans à l'ouverture, Tab et Maj+Tab bouclent dedans
  // (sinon le focus partait dans la barre du navigateur), Échap ferme et rend le focus au déclencheur.
  useEffect(() => {
    if (!drawerOpen) return;
    drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        returnFocus();
        return;
      }
      if (e.key !== "Tab" || !drawerRef.current) return;
      const items = Array.from(drawerRef.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !drawerRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !drawerRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [drawerOpen]);

  const userLabel = user?.name || user?.email || "";
  const tabs = space.tabs.map((id) => findNavItem(id)).filter((i): i is NavItem => Boolean(i));

  const allCreateItems = space.id === "site" ? [
    { label: "Nouvelle réalisation", onSelect: () => navigate("/site/realisations/nouvelle") },
    { label: "Nouveau témoignage", onSelect: () => navigate("/site/avis/nouveau") },
    { label: "Nouvelle référence", onSelect: () => navigate("/site/references/nouvelle") },
    { label: "Nouvelle question", onSelect: () => navigate("/site/faq/nouvelle") },
  ] : [
    { label: "Nouveau devis", onSelect: () => navigate("/quotes?new=1") },
    { label: "Nouvelle facture", onSelect: () => navigate("/invoices?new=1") },
    { label: "Nouveau client", onSelect: () => navigate("/clients?new=1") },
    { label: "Enregistrer un paiement", onSelect: () => navigate("/payments?new=1") },
    // Catalogue : mêmes types que Prestations > Créer.
    { label: "Nouveau service", onSelect: () => navigate("/services?new=service") },
    { label: "Nouvelle option", onSelect: () => navigate("/services?new=option") },
    { label: "Nouveau pack", onSelect: () => navigate("/services?new=pack") },
    ...(features.moduleSubscriptionsEnabled
      ? [
          { label: "Nouvel abonnement", onSelect: () => navigate("/services?new=abonnement") },
          { label: "Nouveau contrat d'abonnement", onSelect: () => navigate("/abonnements?new=1") },
        ]
      : []),
  ];
  // Hors ligne sur l'origine du hors ligne : seulement les créations mises en file (devis brouillon, client).
  const createItems = readOnly && canPrepare
    ? allCreateItems.filter((i) => i.label === "Nouveau devis" || i.label === "Nouveau client")
    : allCreateItems;

  return (
    <NotificationsProvider>
    <div className="flex h-dvh min-w-0 overflow-hidden bg-[var(--bg)]">
      {/* Tiroir ouvert (modale) : le reste de la page est inerte, le focus ne sort pas du tiroir. */}
      <a
        inert={drawerOpen || undefined}
        href="#contenu"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-[var(--radius-sm)] focus:bg-[var(--primary)] focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-[var(--primary-fg)]"
      >
        Aller au contenu
      </a>

      {/* Barre latérale (bureau) */}
      <aside
        inert={drawerOpen || undefined}
        className="hidden w-[var(--sidebar-w)] shrink-0 border-r border-[var(--border)] bg-[var(--bg-subtle)] lg:block">
        <Sidebar pathname={pathname} unread={unreadCount} onLogout={onLogout} userLabel={userLabel} />
      </aside>

      {/* Tiroir (mobile et tablette) */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Fermer le menu"
            className="absolute inset-0 bg-[var(--bg)]/75"
            onClick={() => {
              setDrawerOpen(false);
              returnFocus();
            }}
          />
          <div
            ref={drawerRef}
            id="menu-principal"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="absolute inset-y-0 left-0 flex w-[min(var(--sidebar-w),85vw)] flex-col border-r border-[var(--border)] bg-[var(--bg-subtle)] pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-[var(--shadow)]"
          >
            <button
              type="button"
              onClick={() => {
                setDrawerOpen(false);
                returnFocus();
              }}
              aria-label="Fermer le menu"
              className="absolute right-2 top-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              <FontAwesomeIcon icon={faXmark} className="h-4 w-4" />
            </button>
            <Sidebar pathname={pathname} unread={unreadCount} onLogout={onLogout} userLabel={userLabel} />
          </div>
        </div>
      ) : null}

      <div inert={drawerOpen || undefined} className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Barre supérieure */}
        <header className="z-30 flex h-[var(--topbar-h)] min-w-0 shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--bg)] px-2 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-6">
          <button
            ref={drawerTrigger}
            type="button"
            onClick={openDrawer}
            aria-label="Ouvrir le menu"
            aria-expanded={drawerOpen}
            aria-controls="menu-principal"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] lg:hidden"
          >
            <FontAwesomeIcon icon={faBars} className="h-4 w-4" />
          </button>

          {/* Fil d'Ariane : section > écran */}
          <nav aria-label="Fil d'Ariane" className="hidden min-w-0 items-center gap-2 text-sm md:flex">
            {space.id === "site" ? (
              <>
                <Link to={space.home} className="text-[var(--muted)] hover:text-[var(--text)]">
                  {space.label}
                </Link>
                <span className="text-[var(--muted)]/60" aria-hidden>
                  /
                </span>
              </>
            ) : null}
            {currentSection?.label ? (
              <>
                <span className="text-[var(--muted)]">{currentSection.label}</span>
                <span className="text-[var(--muted)]/60" aria-hidden>
                  /
                </span>
              </>
            ) : null}
            {current ? (
              <Link to={current.to} className="truncate font-medium text-[var(--text)] hover:text-[var(--primary)]">
                {current.label}
              </Link>
            ) : null}
          </nav>
          {/* Espace Site sous 352 px : titre masqué, la place va au bouton Publier (la page garde son titre). */}
          <Link
            to="/"
            className={`min-h-11 min-w-0 flex-1 items-center gap-2 md:hidden ${space.id === "site" ? "hidden min-[22rem]:flex" : "flex"}`}
            aria-label="Kouzia ERP, tableau de bord"
          >
            {/* Sous 400 px : logo masqué, titre court, pour garder le titre lisible à côté des actions. */}
            <BrandMark className="hidden h-7 w-7 shrink-0 min-[25rem]:block" />
            <span className="truncate font-display text-base font-semibold">
              {current?.shortLabel ?? current?.label ?? "Kouzia ERP"}
            </span>
          </Link>

          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="hidden min-h-10 w-64 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] xl:flex"
            >
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5" aria-hidden />
              <span>Rechercher…</span>
              <kbd className="ml-auto rounded border border-[var(--border-strong)] px-1.5 font-mono text-[0.6875rem]">Ctrl K</kbd>
            </button>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Rechercher"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] xl:hidden"
            >
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-4 w-4" />
            </button>
            {queuedItems.length > 0 ? (
              <Link
                to="/a-envoyer"
                aria-label={`À envoyer : ${itemsLabel(queuedItems.length)}`}
                title="À envoyer"
                className="relative hidden min-h-11 min-w-11 min-[25rem]:inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              >
                <FontAwesomeIcon icon={faCloudArrowUp} className="h-4 w-4" aria-hidden />
                <span className="absolute right-0.5 top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[0.625rem] font-semibold leading-4 text-[var(--primary-fg)] tabular-nums" aria-hidden>
                  {queuedItems.length > 99 ? "99+" : queuedItems.length}
                </span>
              </Link>
            ) : null}
            <OfflineCopyIndicator />
            <NotificationBell />
            {space.id === "site" ? (
              <SitePublishBar />
            ) : null}
            <MoreMenu
              items={createItems}
              label={<span className="hidden sm:inline">Créer</span>}
              icon={false}
              variant="primary"
              leading={<FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />}
              ariaLabel="Créer"
              compactMobile
              disabled={readOnly && (!canPrepare || createItems.length === 0)}
              describedBy={readOnly ? readOnlyId : undefined}
            />
            {reason ? (
              <span id={readOnlyId} className="sr-only">
                {reason}
              </span>
            ) : null}
          </div>
        </header>
        <div className="relative z-40 h-0">
          <NetworkStatus />
        </div>
        <VersionNotice />

        {/* Région qui défile : atteignable au clavier (axe scrollable-region-focusable),
            contour visible seulement au focus clavier. « relative » : un élément en position absolue
            (sr-only d'un champ fichier) se place et se coupe dans cette région, sinon il allongeait
            la page entière, qui défilait alors sous la coquille (fiche Réalisation en grand écran). */}
        <main
          ref={mainRef}
          id="contenu"
          tabIndex={isMailWorkspace ? -1 : 0}
          aria-label="Contenu"
          className={`custom-scrollbar relative min-h-0 min-w-0 flex-1 focus:outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)] ${
            isMailWorkspace ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"
          }`}
        >
          <div
            className={
              isMailWorkspace
                ? "flex h-full min-h-0 min-w-0 flex-col"
                : "mx-auto w-full max-w-[var(--content-max)] min-w-0 px-[var(--gutter)] py-5 lg:py-7"
            }
          >
            {pageMissing ? <OfflinePageMissing /> : null}
            <div hidden={pageMissing} className={pageMissing ? "hidden" : "contents"}>
              {[pageEpoch, ...(nextEpoch === null ? [] : [nextEpoch])].map((epoch) => {
                const shown = epoch === pageEpoch;
                return (
                  <div key={epoch} hidden={!shown} inert={!shown} aria-hidden={shown ? undefined : true} className={shown ? "contents" : "hidden"}>
                    <PageErrorBoundary resetKey={pathname}>
                      <Outlet />
                    </PageErrorBoundary>
                  </div>
                );
              })}
            </div>
          </div>
        </main>

        {/* Onglets du bas (mobile) */}
        <nav
          aria-label="Accès rapide"
          className="grid shrink-0 grid-cols-5 border-t border-[var(--border)] bg-[var(--bg-subtle)] pb-[env(safe-area-inset-bottom)] lg:hidden"
        >
          {tabs.map((item) => {
            const active = item.match(pathname);
            return (
              <NavLink
                key={item.id}
                to={item.to}
                end={isSpaceHome(item.to)}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-14 flex-col items-center justify-center gap-1 ${
                  active ? "text-[var(--primary)]" : "text-[var(--muted)]"
                }`}
              >
                <FontAwesomeIcon icon={item.icon} className="h-4 w-4" aria-hidden />
                <span className="max-w-full truncate text-[length:var(--text-tab)] tracking-tight">{item.tabLabel ?? item.shortLabel ?? item.label}</span>
                {item.badge === "unread" && unreadCount > 0 ? (
                  <>
                    {/* Point décoratif ; le nombre est dit en texte (aria-label sur un span n'est pas lu partout). */}
                    <span className="absolute right-[calc(50%-1.25rem)] top-2 h-2 w-2 rounded-full bg-[var(--primary)]" aria-hidden />
                    <span className="sr-only">{`${unreadCount} non lus`}</span>
                  </>
                ) : null}
              </NavLink>
            );
          })}
          <button
            type="button"
            onClick={openDrawer}
            aria-expanded={drawerOpen}
            aria-controls="menu-principal"
            className="relative flex min-h-14 flex-col items-center justify-center gap-1 text-xs text-[var(--muted)]"
          >
            <FontAwesomeIcon icon={faEllipsis} className="h-4 w-4" aria-hidden />
            Plus
            {queuedItems.length > 0 ? (
              <>
                {/* Sous 400 px, le lien « À envoyer » de la barre du haut cède la place : il est dans le menu. */}
                <span className="absolute right-[calc(50%-1.25rem)] top-2 h-2 w-2 rounded-full bg-[var(--primary)] min-[25rem]:hidden" aria-hidden />
                <span className="sr-only">{`, ${queuedItems.length} à envoyer`}</span>
              </>
            ) : null}
          </button>
        </nav>
      </div>

      {paletteOpen || paletteUsed ? (
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      ) : null}
    </div>
    </NotificationsProvider>
  );
}
