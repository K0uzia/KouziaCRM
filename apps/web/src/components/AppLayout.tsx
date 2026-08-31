import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faMagnifyingGlass,
  faGear,
  faRightFromBracket,
} from "@fortawesome/free-solid-svg-icons";
import { useAuth } from "@/lib/auth";
import { CommandPalette } from "@/components/CommandPalette";
import { getHubFromPath, HUBS, SUB_NAV } from "@/lib/navigation";

export function AppLayout() {
  const { logout } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { pathname } = useLocation();
  const hub = getHubFromPath(pathname);
  const subNav = hub && hub !== "home" ? SUB_NAV[hub] : null;

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

  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)]">
      <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--bg)]/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-gradient-to-br from-[var(--gradient-from)] to-[var(--gradient-to)] text-sm font-bold text-white">
              K
            </div>
            <span className="hidden font-bold tracking-tight text-[var(--text)] sm:inline">
              Kouzia
            </span>
          </Link>

          <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar">
            {HUBS.map((item) => (
              <NavLink
                key={item.id}
                to={item.to}
                end={item.id === "home"}
                className={({ isActive }) =>
                  `shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium transition ${
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

          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="rounded-[var(--radius-sm)] p-2 text-[var(--muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              aria-label="Rechercher"
              title="Rechercher (⌘K)"
            >
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-4 w-4" />
            </button>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `rounded-[var(--radius-sm)] p-2 transition ${
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
              className="rounded-[var(--radius-sm)] p-2 text-[var(--muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
              aria-label="Sortir"
            >
              <FontAwesomeIcon icon={faRightFromBracket} className="h-4 w-4" />
            </button>
          </div>
        </div>

        {subNav ? (
          <div className="border-t border-[var(--border)]">
            <div className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 py-2 no-scrollbar sm:px-6">
              {subNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={() =>
                    `shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
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
          </div>
        ) : null}
      </header>

      <main className="min-w-0 flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Outlet />
        </div>
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
