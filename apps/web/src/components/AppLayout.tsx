import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChartLine,
  faUsers,
  faFileInvoice,
  faFileSignature,
  faBuildingColumns,
  faGear,
  faInbox,
  faRightFromBracket,
  faMoneyBillWave,
  faBriefcase,
  faBook,
  faClipboardCheck,
  faRepeat,
  faMagnifyingGlass,
  faLandmark,
} from "@fortawesome/free-solid-svg-icons";
import { useAuth } from "@/lib/auth";
import { CommandPalette } from "@/components/CommandPalette";

const links = [
  { to: "/", label: "Tableau de bord", icon: faChartLine, end: true },
  { to: "/clients", label: "Clients", icon: faUsers },
  { to: "/services", label: "Prestations", icon: faBriefcase },
  { to: "/abonnements", label: "Abonnements", icon: faRepeat },
  { to: "/quotes", label: "Devis", icon: faFileSignature },
  { to: "/invoices", label: "Factures", icon: faFileInvoice },
  { to: "/payments", label: "Paiements", icon: faMoneyBillWave },
  { to: "/receipts", label: "Recettes", icon: faBook },
  { to: "/obligations", label: "Obligations", icon: faClipboardCheck },
  { to: "/banque", label: "Banque", icon: faBuildingColumns },
  { to: "/urssaf", label: "URSSAF", icon: faLandmark },
  { to: "/inbox", label: "Emails", icon: faInbox },
  { to: "/settings", label: "Paramètres", icon: faGear },
];

export function AppLayout() {
  const { logout, user } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);

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
    <div className="flex min-h-screen bg-[var(--bg)]">
      <aside className="sticky top-0 flex h-screen w-[240px] shrink-0 flex-col bg-[var(--sidebar)] text-[var(--sidebar-text)]">
        <div className="border-b border-white/10 px-5 py-5">
          <p className="text-lg font-semibold tracking-tight text-white">Kouzia</p>
          <p className="mt-0.5 text-xs text-white/45">CRM & facturation</p>
        </div>
        <nav className="no-scrollbar flex flex-1 flex-col gap-0.5 overflow-y-auto p-3">
          {links.map(({ to, label, icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
                  isActive
                    ? "bg-white/10 font-medium text-white"
                    : "text-white/65 hover:bg-white/5 hover:text-white"
                }`
              }
            >
              <FontAwesomeIcon icon={icon} className="h-4 w-4 opacity-80" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="mb-2 flex w-full items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2 text-xs text-white/55 hover:bg-white/10 hover:text-white/80"
          >
            <span className="flex items-center gap-2">
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5" />
              Rechercher
            </span>
            <kbd className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/60">
              ⌘K
            </kbd>
          </button>
          <p className="mb-2 truncate px-3 text-xs text-white/40">{user?.email}</p>
          <button
            type="button"
            onClick={() => void logout()}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-white/65 hover:bg-white/5 hover:text-white"
          >
            <FontAwesomeIcon icon={faRightFromBracket} className="h-4 w-4" />
            Déconnexion
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 md:px-8 md:py-8">
          <Outlet />
        </div>
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
