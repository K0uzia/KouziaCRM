import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBars,
  faEllipsis,
  faMagnifyingGlass,
  faPlus,
  faRightFromBracket,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import { useAuth } from "@/lib/auth";
import { CommandPalette } from "@/components/CommandPalette";
import { NewMailPill } from "@/components/NewMailPill";
import { MoreMenu } from "@/components/ui/MoreMenu";
import { useNewMailAlert } from "@/hooks/useNewMailAlert";
import {
  filterSections,
  findNavItem,
  locate,
  MOBILE_TABS,
  NAV_SECTIONS,
  SETTINGS_ITEM,
  type NavItem,
} from "@/lib/navigation";
import { useFeatures } from "@/lib/features";

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

/** Lien de la barre latérale : icône, libellé, compteur, état actif (barre ambre + fond). */
function SideLink({ item, active, unread }: { item: NavItem; active: boolean; unread: number }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
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
  const sections = filterSections(NAV_SECTIONS, features);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link to="/" className="flex h-[var(--topbar-h)] shrink-0 items-center gap-2.5 px-5" aria-label="Kouzia ERP, tableau de bord">
        <BrandMark />
        <span className="font-display text-lg font-semibold tracking-wide text-[var(--text)]">
          Kouzia <span className="text-[var(--primary)]">ERP</span>
        </span>
      </Link>
      <nav aria-label="Navigation principale" className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {sections.map((section) => (
          <div key={section.id} className="mt-4 first:mt-1">
            {section.label ? (
              <p className="mb-1 px-3 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-[var(--muted)]/80">
                {section.label}
              </p>
            ) : null}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.id}>
                  <SideLink item={item} active={item.match(pathname)} unread={unread} />
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
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const features = useFeatures();
  const { item: current, section: currentSection } = locate(pathname);
  const {
    visible: newMailVisible,
    unreadCount,
    dismiss: dismissNewMail,
  } = useNewMailAlert();
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

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.title = current ? `${current.label} · Kouzia ERP` : "Kouzia ERP";
  }, [current]);

  // Tiroir mobile : focus dedans à l'ouverture, Échap ferme et rend le focus au bouton menu.
  useEffect(() => {
    if (!drawerOpen) return;
    drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDrawerOpen(false);
        drawerTrigger.current?.focus();
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
  const tabs = MOBILE_TABS.map((id) => findNavItem(id)).filter((i): i is NavItem => Boolean(i));

  const createItems = [
    { label: "Nouveau devis", onSelect: () => navigate("/quotes?new=1") },
    { label: "Nouvelle facture", onSelect: () => navigate("/invoices?new=1") },
    { label: "Nouveau client", onSelect: () => navigate("/clients?new=1") },
    { label: "Enregistrer un paiement", onSelect: () => navigate("/payments?new=1") },
    ...(features.moduleSubscriptionsEnabled
      ? [{ label: "Nouvel abonnement", onSelect: () => navigate("/abonnements?new=1") }]
      : []),
  ];

  return (
    <div className="flex h-dvh min-w-0 overflow-hidden bg-[var(--bg)]">
      <a
        href="#contenu"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-[var(--radius-sm)] focus:bg-[var(--primary)] focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-[var(--primary-fg)]"
      >
        Aller au contenu
      </a>

      {/* Barre latérale (bureau) */}
      <aside className="hidden w-[var(--sidebar-w)] shrink-0 border-r border-[var(--border)] bg-[var(--bg-subtle)] lg:block">
        <Sidebar pathname={pathname} unread={unreadCount} onLogout={() => void logout()} userLabel={userLabel} />
      </aside>

      {/* Tiroir (mobile et tablette) */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Fermer le menu"
            className="absolute inset-0 bg-[var(--bg)]/75"
            onClick={() => setDrawerOpen(false)}
          />
          <div
            ref={drawerRef}
            id="menu-principal"
            className="absolute inset-y-0 left-0 flex w-[min(var(--sidebar-w),85vw)] flex-col border-r border-[var(--border)] bg-[var(--bg-subtle)] pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-[var(--shadow)]"
          >
            <button
              type="button"
              onClick={() => {
                setDrawerOpen(false);
                drawerTrigger.current?.focus();
              }}
              aria-label="Fermer le menu"
              className="absolute right-2 top-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              <FontAwesomeIcon icon={faXmark} className="h-4 w-4" />
            </button>
            <Sidebar pathname={pathname} unread={unreadCount} onLogout={() => void logout()} userLabel={userLabel} />
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Barre supérieure */}
        <header className="z-30 flex h-[var(--topbar-h)] shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg)] px-3 pt-[env(safe-area-inset-top)] sm:gap-3 sm:px-6">
          <button
            ref={drawerTrigger}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Ouvrir le menu"
            aria-expanded={drawerOpen}
            aria-controls="menu-principal"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-sm)] text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] lg:hidden"
          >
            <FontAwesomeIcon icon={faBars} className="h-4 w-4" />
          </button>

          {/* Fil d'Ariane : section > écran */}
          <nav aria-label="Fil d'Ariane" className="hidden min-w-0 items-center gap-2 text-sm md:flex">
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
          <Link to="/" className="flex min-h-11 items-center gap-2 md:hidden" aria-label="Kouzia ERP, tableau de bord">
            <BrandMark className="h-7 w-7" />
            <span className="truncate font-display text-base font-semibold">{current?.label ?? "Kouzia ERP"}</span>
          </Link>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
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
            <MoreMenu
              items={createItems}
              label={<span className="hidden sm:inline">Créer</span>}
              icon={false}
              variant="primary"
              leading={<FontAwesomeIcon icon={faPlus} className="h-3.5 w-3.5" aria-hidden />}
              ariaLabel="Créer"
            />
          </div>
        </header>

        <main
          id="contenu"
          tabIndex={-1}
          className={`custom-scrollbar min-h-0 min-w-0 flex-1 focus:outline-none ${
            isMailWorkspace ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"
          }`}
        >
          <div
            className={
              isMailWorkspace
                ? "flex h-full min-h-0 min-w-0 flex-col"
                : "mx-auto w-full max-w-[90rem] min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-7"
            }
          >
            <Outlet />
          </div>
        </main>

        {/* Onglets du bas (mobile) */}
        <nav
          aria-label="Accès rapide"
          className="grid shrink-0 grid-cols-5 border-t border-[var(--border)] bg-[var(--bg-subtle)] pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {tabs.map((item) => {
            const active = item.match(pathname);
            return (
              <NavLink
                key={item.id}
                to={item.to}
                end={item.to === "/"}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-14 flex-col items-center justify-center gap-1 text-[0.6875rem] ${
                  active ? "text-[var(--primary)]" : "text-[var(--muted)]"
                }`}
              >
                <FontAwesomeIcon icon={item.icon} className="h-4 w-4" aria-hidden />
                <span className="max-w-full truncate px-1">{item.id === "dashboard" ? "Accueil" : item.label}</span>
                {item.badge === "unread" && unreadCount > 0 ? (
                  <span className="absolute right-[calc(50%-1.25rem)] top-2 h-2 w-2 rounded-full bg-[var(--primary)]" aria-label={`${unreadCount} non lus`} />
                ) : null}
              </NavLink>
            );
          })}
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-controls="menu-principal"
            className="flex min-h-14 flex-col items-center justify-center gap-1 text-[0.6875rem] text-[var(--muted)]"
          >
            <FontAwesomeIcon icon={faEllipsis} className="h-4 w-4" aria-hidden />
            Plus
          </button>
        </nav>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <NewMailPill
        visible={newMailVisible && !pathname.startsWith("/inbox")}
        unreadCount={unreadCount}
        onDismiss={dismissNewMail}
      />
    </div>
  );
}
