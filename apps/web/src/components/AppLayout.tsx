import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faMagnifyingGlass,
  faGear,
  faRightFromBracket,
  faEnvelope,
  faBars,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";
import { useAuth } from "@/lib/auth";
import { CommandPalette } from "@/components/CommandPalette";
import { NewMailPill } from "@/components/NewMailPill";
import { useNewMailAlert } from "@/hooks/useNewMailAlert";
import { getHubFromPath, HUBS, SUB_NAV, filterSubNav } from "@/lib/navigation";
import { useFeatures } from "@/lib/features";

const iconBtn =
  "inline-flex min-h-11 min-w-11 shrink-0 touch-manipulation items-center justify-center rounded-[var(--radius-sm)] transition";

export function AppLayout() {
  const { logout } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { pathname } = useLocation();
  const features = useFeatures();
  const hub = getHubFromPath(pathname);
  const subNav =
    hub && hub !== "home"
      ? filterSubNav(SUB_NAV[hub], features)
      : null;
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
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [menuOpen]);

  return (
    <div className="flex h-dvh min-w-0 flex-col overflow-hidden bg-[var(--bg)]">
      <header className="z-40 shrink-0 border-b border-[var(--border)] bg-[var(--bg)]/90 pt-[env(safe-area-inset-top)] backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl min-w-0 items-center gap-2 px-4 sm:gap-3 sm:px-6">
          <Link
            to="/"
            className="flex min-h-11 shrink-0 items-center gap-2.5"
            aria-label="Kouzia, accueil"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-gradient-to-br from-[var(--gradient-from)] to-[var(--gradient-to)] text-sm font-bold text-white">
              K
            </div>
            <span className="hidden font-bold tracking-tight text-[var(--text)] md:inline">
              Kouzia
            </span>
          </Link>

          <button
            type="button"
            className={`${iconBtn} md:hidden ${
              menuOpen
                ? "text-[var(--primary)]"
                : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            }`}
            aria-label={menuOpen ? "Fermer le menu" : "Ouvrir le menu"}
            aria-expanded={menuOpen}
            aria-controls="mobile-hub-menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <FontAwesomeIcon icon={menuOpen ? faXmark : faBars} className="h-4 w-4" />
          </button>

          <nav
            className="hidden min-w-0 flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar md:flex"
            aria-label="Navigation principale"
          >
            {HUBS.map((item) => (
              <NavLink
                key={item.id}
                to={item.to}
                end={item.id === "home"}
                className={({ isActive }) =>
                  `inline-flex min-h-11 shrink-0 touch-manipulation items-center whitespace-nowrap rounded-[var(--radius-sm)] px-3 text-sm font-medium transition ${
                    isActive || hub === item.id
                      ? "bg-[var(--primary-soft)] text-[var(--primary)]"
                      : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="min-w-0 flex-1 md:hidden" />

          <div className="flex shrink-0 items-center">
            <NavLink
              to="/inbox"
              className={({ isActive }) =>
                `relative ${iconBtn} ${
                  isActive || pathname.startsWith("/inbox")
                    ? "text-[var(--primary)]"
                    : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                }`
              }
              aria-label={
                unreadCount > 0
                  ? `Boîte mail (${unreadCount} non lus)`
                  : "Boîte mail"
              }
              title="Boîte mail"
            >
              <FontAwesomeIcon icon={faEnvelope} className="h-4 w-4" />
              {unreadCount > 0 ? (
                <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--danger)] px-1 text-[9px] font-bold leading-none text-white">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              ) : null}
            </NavLink>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className={`${iconBtn} text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]`}
              aria-label="Rechercher"
              title="Rechercher (⌘K)"
            >
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-4 w-4" />
            </button>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `${iconBtn} ${
                  isActive
                    ? "text-[var(--primary)]"
                    : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                }`
              }
              aria-label="Réglages"
            >
              <FontAwesomeIcon icon={faGear} className="h-4 w-4" />
            </NavLink>
            <button
              type="button"
              onClick={() => void logout()}
              className={`${iconBtn} text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]`}
              aria-label="Sortir"
            >
              <FontAwesomeIcon icon={faRightFromBracket} className="h-4 w-4" />
            </button>
          </div>
        </div>

        {menuOpen ? (
          <nav
            id="mobile-hub-menu"
            aria-label="Navigation principale"
            className="border-t border-[var(--border)] bg-[var(--bg)] px-4 py-3 md:hidden"
          >
            <ul className="mx-auto max-w-7xl space-y-1">
              {HUBS.map((item) => (
                <li key={item.id}>
                  <NavLink
                    to={item.to}
                    end={item.id === "home"}
                    className={() =>
                      `flex min-h-12 touch-manipulation items-center rounded-[var(--radius)] px-4 text-sm font-medium ${
                        hub === item.id
                          ? "bg-[var(--primary-soft)] text-[var(--primary)]"
                          : "text-[var(--text)] hover:bg-[var(--surface-hover)]"
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        {subNav && !menuOpen ? (
          <div className="border-t border-[var(--border)]">
            <div className="relative mx-auto max-w-7xl">
              <div
                className="flex max-w-7xl gap-1 overflow-x-auto px-4 py-1 no-scrollbar sm:px-6"
                aria-label="Sous-navigation"
              >
                {subNav.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={() =>
                      `inline-flex min-h-11 shrink-0 touch-manipulation items-center whitespace-nowrap rounded-full px-3.5 text-xs font-medium transition ${
                        item.match(pathname)
                          ? "bg-[var(--surface-hover)] text-[var(--text)] ring-1 ring-[var(--border-strong)]"
                          : "text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
                      }`
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </div>
              <div
                className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--bg)] to-transparent md:hidden"
                aria-hidden
              />
            </div>
          </div>
        ) : null}
      </header>

      {menuOpen ? (
        <button
          type="button"
          aria-label="Fermer le menu"
          className="fixed inset-0 z-30 bg-[var(--text)]/20 md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <main
        className={`custom-scrollbar min-h-0 min-w-0 flex-1 ${
          isMailWorkspace ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"
        }`}
      >
        <div
          className={
            isMailWorkspace
              ? "flex h-full min-h-0 min-w-0 flex-col"
              : "mx-auto max-w-7xl min-w-0 px-4 py-4 sm:px-6 sm:py-8"
          }
        >
          <Outlet />
        </div>
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <NewMailPill
        visible={newMailVisible}
        unreadCount={unreadCount}
        onDismiss={dismissNewMail}
      />
    </div>
  );
}
