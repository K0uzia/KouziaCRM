"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChartLine,
  faUsers,
  faFileInvoice,
  faBuildingColumns,
  faGear,
  faInbox,
  faRightFromBracket,
} from "@fortawesome/free-solid-svg-icons";
import { cn } from "@/lib/utils";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

const links = [
  { href: "/dashboard", label: "Dashboard", icon: faChartLine },
  { href: "/clients", label: "Clients", icon: faUsers },
  { href: "/invoices", label: "Factures", icon: faFileInvoice },
  { href: "/banque", label: "Banque / Virements", icon: faBuildingColumns },
  { href: "/inbox", label: "Inbox", icon: faInbox },
  { href: "/settings", label: "Paramètres", icon: faGear },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Précharge toutes les routes dès le montage (évite le blanc au 1er clic)
  useEffect(() => {
    for (const { href } of links) {
      router.prefetch(href);
    }
  }, [router]);

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border bg-[#0f1c17] text-[#e8f0ec]">
      <div className="border-b border-white/10 px-5 py-6">
        <p className="font-[family-name:var(--font-display)] text-2xl tracking-tight text-[#c8e6d4]">
          Kouzia
        </p>
        <p className="mt-1 text-xs text-white/50">CRM & facturation EI</p>
        {pending ? (
          <p className="mt-2 text-[11px] text-[#c8e6d4]/70">Chargement…</p>
        ) : null}
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {links.map(({ href, label, icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              prefetch
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                startTransition(() => {
                  router.push(href);
                });
              }}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-all duration-200",
                active
                  ? "bg-[#1f3d30] text-white"
                  : "text-white/70 hover:bg-white/5 hover:text-white",
                pending && !active && "opacity-60",
              )}
            >
              <FontAwesomeIcon icon={icon} className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-white/10 p-3">
        <Button
          variant="ghost"
          className="w-full justify-start gap-3 text-white/70 hover:bg-white/5 hover:text-white"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          <FontAwesomeIcon icon={faRightFromBracket} className="h-4 w-4" />
          Déconnexion
        </Button>
      </div>
    </aside>
  );
}
