export type HubId = "home" | "activity" | "billing" | "offer" | "finance";

export const HUBS: Array<{ id: HubId; label: string; to: string }> = [
  { id: "home", label: "Accueil", to: "/" },
  { id: "activity", label: "Activité", to: "/clients" },
  { id: "billing", label: "Facturation", to: "/quotes" },
  { id: "offer", label: "Offre", to: "/services" },
  { id: "finance", label: "Finances", to: "/banque" },
];

export type SubNavItem = {
  to: string;
  label: string;
  match: (pathname: string) => boolean;
};

export const SUB_NAV: Record<Exclude<HubId, "home">, SubNavItem[]> = {
  activity: [
    {
      to: "/clients",
      label: "Clients",
      match: (p) => p === "/clients" || p.startsWith("/clients/"),
    },
    {
      to: "/inbox",
      label: "Messages",
      match: (p) => p.startsWith("/inbox"),
    },
    {
      to: "/avis",
      label: "Avis",
      match: (p) => p === "/avis",
    },
  ],
  billing: [
    { to: "/quotes", label: "Devis", match: (p) => p.startsWith("/quotes") },
    { to: "/invoices", label: "Factures", match: (p) => p.startsWith("/invoices") },
    { to: "/payments", label: "Encaissements", match: (p) => p === "/payments" },
    { to: "/receipts", label: "Livre de recettes", match: (p) => p === "/receipts" },
  ],
  offer: [
    { to: "/services", label: "Prestations", match: (p) => p === "/services" },
    { to: "/abonnements", label: "Abonnements", match: (p) => p.startsWith("/abonnements") },
  ],
  finance: [
    { to: "/banque", label: "Virements", match: (p) => p === "/banque" },
    { to: "/obligations", label: "Démarches", match: (p) => p === "/obligations" },
    { to: "/urssaf", label: "URSSAF", match: (p) => p === "/urssaf" },
  ],
};

export function getHubFromPath(pathname: string): HubId | null {
  if (pathname === "/") return "home";
  if (
    pathname.startsWith("/clients") ||
    pathname.startsWith("/inbox") ||
    pathname === "/avis"
  ) {
    return "activity";
  }
  if (
    pathname.startsWith("/quotes") ||
    pathname.startsWith("/invoices") ||
    pathname === "/payments" ||
    pathname === "/receipts"
  ) {
    return "billing";
  }
  if (pathname.startsWith("/services") || pathname.startsWith("/abonnements")) return "offer";
  if (
    pathname === "/banque" ||
    pathname === "/obligations" ||
    pathname === "/urssaf"
  ) {
    return "finance";
  }
  return null;
}
