import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faBook,
  faBoxOpen,
  faChartPie,
  faClipboardCheck,
  faCommentDots,
  faEnvelope,
  faFileInvoice,
  faFileSignature,
  faGear,
  faLandmark,
  faMoneyBillTransfer,
  faRotate,
  faUsers,
  faWallet,
} from "@fortawesome/free-solid-svg-icons";

export type FeatureFlags = {
  moduleBankEnabled: boolean;
  moduleSubscriptionsEnabled: boolean;
  moduleStripeEnabled: boolean;
};

export type NavItem = {
  id: string;
  to: string;
  label: string;
  /** Titre de l'en-tête mobile quand le libellé ne tient pas à 320 px. */
  shortLabel?: string;
  icon: IconDefinition;
  match: (pathname: string) => boolean;
  feature?: keyof FeatureFlags;
  /** Compteur affiché à droite (messages non lus). */
  badge?: "unread";
};

export type NavSection = { id: string; label: string | null; items: NavItem[] };

const starts = (prefix: string) => (p: string) => p === prefix || p.startsWith(`${prefix}/`);

/** Arborescence de l'ERP, par métier. Source unique : barre latérale, tiroir mobile et fil d'Ariane. */
export const NAV_SECTIONS: NavSection[] = [
  {
    id: "pilotage",
    label: null,
    items: [
      { id: "dashboard", to: "/", label: "Tableau de bord", shortLabel: "Accueil", icon: faChartPie, match: (p) => p === "/" },
      { id: "todo", to: "/obligations", label: "Démarches", icon: faClipboardCheck, match: starts("/obligations") },
    ],
  },
  {
    id: "ventes",
    label: "Ventes",
    items: [
      { id: "clients", to: "/clients", label: "Clients", icon: faUsers, match: starts("/clients") },
      { id: "quotes", to: "/quotes", label: "Devis", icon: faFileSignature, match: starts("/quotes") },
      { id: "invoices", to: "/invoices", label: "Factures", icon: faFileInvoice, match: starts("/invoices") },
      { id: "payments", to: "/payments", label: "Encaissements", icon: faWallet, match: starts("/payments") },
    ],
  },
  {
    id: "offre",
    label: "Offre",
    items: [
      { id: "services", to: "/services", label: "Prestations", icon: faBoxOpen, match: starts("/services") },
      {
        id: "subscriptions",
        to: "/abonnements",
        label: "Abonnements",
        icon: faRotate,
        match: starts("/abonnements"),
        feature: "moduleSubscriptionsEnabled",
      },
    ],
  },
  {
    id: "compta",
    label: "Comptabilité",
    items: [
      { id: "receipts", to: "/receipts", label: "Livre de recettes", shortLabel: "Recettes", icon: faBook, match: starts("/receipts") },
      { id: "urssaf", to: "/urssaf", label: "URSSAF", icon: faLandmark, match: starts("/urssaf") },
      {
        id: "payouts",
        to: "/versements",
        label: "Versements Stripe",
        shortLabel: "Versements",
        icon: faMoneyBillTransfer,
        match: starts("/versements"),
        feature: "moduleStripeEnabled",
      },
    ],
  },
  {
    id: "relation",
    label: "Relation client",
    items: [
      { id: "inbox", to: "/inbox", label: "Messagerie", icon: faEnvelope, match: starts("/inbox"), badge: "unread" },
      { id: "reviews", to: "/avis", label: "Avis clients", shortLabel: "Avis", icon: faCommentDots, match: starts("/avis") },
    ],
  },
];

export const SETTINGS_ITEM: NavItem = {
  id: "settings",
  to: "/settings",
  label: "Réglages",
  icon: faGear,
  match: starts("/settings"),
};

/** Onglets du bas sur mobile : les 4 écrans du quotidien, le reste est dans le menu. */
export const MOBILE_TABS = ["dashboard", "clients", "invoices", "inbox"] as const;

export function filterSections(sections: NavSection[], flags: FeatureFlags): NavSection[] {
  return sections
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.feature || flags[i.feature]) }))
    .filter((s) => s.items.length > 0);
}

export function findNavItem(id: string): NavItem | undefined {
  return [...NAV_SECTIONS.flatMap((s) => s.items), SETTINGS_ITEM].find((i) => i.id === id);
}

/** Section et entrée correspondant à une URL (fil d'Ariane, titre de l'onglet). */
export function locate(pathname: string): { section: NavSection | null; item: NavItem | null } {
  if (SETTINGS_ITEM.match(pathname)) return { section: null, item: SETTINGS_ITEM };
  for (const section of NAV_SECTIONS) {
    const item = section.items.find((i) => i.match(pathname));
    if (item) return { section, item };
  }
  return { section: null, item: null };
}
