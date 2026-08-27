import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { api } from "@/lib/api";

type ClientHit = {
  id: string;
  displayName: string;
  clientNumber?: string | null;
  city?: string | null;
};

const NAV_ITEMS = [
  { label: "Tableau de bord", to: "/" },
  { label: "Clients", to: "/clients" },
  { label: "Prestations", to: "/services" },
  { label: "Abonnements", to: "/abonnements" },
  { label: "Devis", to: "/quotes" },
  { label: "Factures", to: "/invoices" },
  { label: "Paiements", to: "/payments" },
  { label: "Recettes", to: "/receipts" },
  { label: "Obligations", to: "/obligations" },
  { label: "Banque", to: "/banque" },
  { label: "URSSAF", to: "/urssaf" },
  { label: "Emails", to: "/inbox" },
  { label: "Paramètres", to: "/settings" },
];

const QUICK_ACTIONS = [
  { label: "Nouveau devis", to: "/quotes?new=1" },
  { label: "Nouvelle facture", to: "/invoices?new=1" },
  { label: "Nouveau client", to: "/clients?new=1" },
  { label: "Composer un email", to: "/inbox/compose" },
];

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const navigate = useNavigate();
  const [clients, setClients] = useState<ClientHit[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    api<ClientHit[]>("/api/clients")
      .then(setClients)
      .catch(() => {
        /* ignore : palette reste utilisable sans recherche clients */
      });
  }, [open]);

  const clientHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return clients
      .filter(
        (c) =>
          c.displayName.toLowerCase().includes(q) ||
          c.clientNumber?.toLowerCase().includes(q) ||
          c.city?.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [clients, query]);

  function go(to: string) {
    onOpenChange(false);
    navigate(to);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Palette de commandes"
      shouldFilter={clientHits.length === 0}
      loop
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4"
    >
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/40"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      {/* Boîte */}
      <div className="relative z-10 w-full max-w-xl overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-lg">
        <Command.Input
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder="Rechercher une page, une action ou un client…"
          className="w-full border-b border-[var(--border)] px-4 py-3 text-sm outline-none bg-transparent text-[var(--text)] placeholder:text-[var(--muted)]"
        />
        <Command.List className="max-h-[60vh] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-sm text-[var(--muted)]">
            Aucun résultat.
          </Command.Empty>

          <Command.Group
            heading="Navigation"
            className="px-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-[var(--muted)]"
          >
            {NAV_ITEMS.map((item) => (
              <Command.Item
                key={item.to}
                onSelect={() => go(item.to)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text)] data-[selected=true]:bg-[var(--primary-soft)] data-[selected=true]:text-[var(--primary)]"
              >
                {item.label}
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group
            heading="Actions rapides"
            className="px-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-[var(--muted)]"
          >
            {QUICK_ACTIONS.map((item) => (
              <Command.Item
                key={item.to}
                onSelect={() => go(item.to)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm text-[var(--text)] data-[selected=true]:bg-[var(--primary-soft)] data-[selected=true]:text-[var(--primary)]"
              >
                {item.label}
              </Command.Item>
            ))}
          </Command.Group>

          {clientHits.length > 0 ? (
            <Command.Group
              heading="Clients"
              className="px-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-[var(--muted)]"
            >
              {clientHits.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`client ${c.displayName} ${c.clientNumber ?? ""} ${c.city ?? ""}`}
                  onSelect={() => go(`/clients/${c.id}`)}
                  className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-2 text-sm text-[var(--text)] data-[selected=true]:bg-[var(--primary-soft)] data-[selected=true]:text-[var(--primary)]"
                >
                  <span className="font-medium">{c.displayName}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {c.clientNumber ?? ""}
                    {c.city ? ` · ${c.city}` : ""}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
