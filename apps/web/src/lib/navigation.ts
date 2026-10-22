import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faKey,
  faBook,
  faBoxOpen,
  faChartPie,
  faCircleQuestion,
  faGlobe,
  faHandshake,
  faImages,
  faPhotoFilm,
  faFileLines,
  faClockRotateLeft,
  faPlug,
  faStar,
  faClipboardCheck,
  faCloudArrowUp,
  faEnvelope,
  faFileInvoice,
  faFileSignature,
  faGear,
  faLandmark,
  faMoneyBillTransfer,
  faHandHoldingDollar,
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
  /** Libellé de l'onglet du bas (5 onglets à 320 px), si différent du titre court. */
  tabLabel?: string;
  icon: IconDefinition;
  match: (pathname: string) => boolean;
  feature?: keyof FeatureFlags;
  /** Compteur affiché à droite : messages non lus, créations hors ligne à envoyer, demandes de logiciel en attente. */
  badge?: "unread" | "queue" | "requests";
  /** Écran du hors ligne : affiché seulement sur l'origine du hors ligne (erp.kouzia.com). */
  offlineOnly?: boolean;
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
      // Créations préparées hors ligne (lib/offline/queue) : liste, état, nouvel essai, suppression.
      { id: "outbox", to: "/a-envoyer", label: "À envoyer", icon: faCloudArrowUp, match: starts("/a-envoyer"), badge: "queue", offlineOnly: true },
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
      { id: "withdrawals", to: "/retraits", label: "Retraits", icon: faHandHoldingDollar, match: starts("/retraits") },
      {
        id: "payouts",
        to: "/flux-stripe",
        label: "Flux Stripe",
        shortLabel: "Flux",
        icon: faMoneyBillTransfer,
        match: starts("/flux-stripe"),
        feature: "moduleStripeEnabled",
      },
    ],
  },
  {
    id: "relation",
    label: "Relation client",
    items: [
      { id: "inbox", to: "/inbox", label: "Messagerie", tabLabel: "Messages", icon: faEnvelope, match: starts("/inbox"), badge: "unread" },
      { id: "software-requests", to: "/demandes-logiciel", label: "Demandes logiciel", icon: faKey, match: starts("/demandes-logiciel"), badge: "requests" },
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

/** Espace « Site » : contenu de kouzia.com, saisi dans l'ERP puis publié dans le dépôt du site. */
export const SITE_SECTIONS: NavSection[] = [
  {
    id: "site-pilotage",
    label: null,
    items: [
      { id: "site-overview", to: "/site", label: "Vue d'ensemble", shortLabel: "Site", icon: faGlobe, match: (p) => p === "/site" },
    ],
  },
  {
    id: "site-contenu",
    label: "Contenu",
    items: [
      { id: "site-projects", to: "/site/realisations", label: "Réalisations", tabLabel: "Projets", icon: faImages, match: starts("/site/realisations") },
      // Adresse /site/avis gardée (liens et notifications existants) ; l'écran s'appelle « Témoignages ».
      { id: "site-reviews", to: "/site/avis", label: "Témoignages", tabLabel: "Retours", icon: faStar, match: starts("/site/avis") },
      { id: "site-references", to: "/site/references", label: "Références", icon: faHandshake, match: starts("/site/references") },
      { id: "site-faq", to: "/site/faq", label: "FAQ", icon: faCircleQuestion, match: starts("/site/faq") },
      { id: "site-media", to: "/site/images", label: "Images", icon: faPhotoFilm, match: starts("/site/images") },
      // Coordonnées, accroche, offres, textes des pages, référencement, menus et espace client : un seul écran généré
      // depuis le contrat du site (les anciennes adresses y renvoient).
      {
        id: "site-texts",
        to: "/site/tous-les-textes",
        label: "Tous les textes",
        shortLabel: "Textes",
        icon: faFileLines,
        match: starts("/site/tous-les-textes"),
      },
    ],
  },
  {
    id: "site-publication",
    label: "Publication",
    items: [
      { id: "site-history", to: "/site/historique", label: "Historique", icon: faClockRotateLeft, match: starts("/site/historique") },
      {
        id: "site-github",
        to: "/site/connexion",
        label: "Connexion au dépôt",
        shortLabel: "Connexion",
        icon: faPlug,
        match: starts("/site/connexion"),
      },
    ],
  },
];

export type NavSpaceId = "gestion" | "site";
export type NavSpace = {
  id: NavSpaceId;
  label: string;
  /** Écran d'arrivée quand on bascule vers cet espace. */
  home: string;
  sections: NavSection[];
  /** Onglets du bas sur mobile (4 au plus, « Plus » ouvre le tiroir). */
  tabs: readonly string[];
};

/** Deux espaces : la gestion de l'entreprise et le site kouzia.com. L'URL décide de l'espace affiché. */
export const NAV_SPACES: readonly NavSpace[] = [
  { id: "gestion", label: "Gestion", home: "/", sections: NAV_SECTIONS, tabs: MOBILE_TABS },
  {
    id: "site",
    label: "Site",
    home: "/site",
    sections: SITE_SECTIONS,
    tabs: ["site-overview", "site-projects", "site-reviews", "site-contact"],
  },
];

const isSitePath = starts("/site");

export function spaceOf(pathname: string): NavSpace {
  return NAV_SPACES[isSitePath(pathname) ? 1 : 0]!;
}

export function filterSections(sections: NavSection[], flags: FeatureFlags, offline = false): NavSection[] {
  return sections
    .map((s) => ({ ...s, items: s.items.filter((i) => (!i.feature || flags[i.feature]) && (!i.offlineOnly || offline)) }))
    .filter((s) => s.items.length > 0);
}

const ALL_SECTIONS = NAV_SPACES.flatMap((space) => space.sections);

export function findNavItem(id: string): NavItem | undefined {
  return [...ALL_SECTIONS.flatMap((s) => s.items), SETTINGS_ITEM].find((i) => i.id === id);
}

/** Section et entrée correspondant à une URL (fil d'Ariane, titre de l'onglet). */
export function locate(pathname: string): { section: NavSection | null; item: NavItem | null } {
  if (SETTINGS_ITEM.match(pathname)) return { section: null, item: SETTINGS_ITEM };
  for (const section of spaceOf(pathname).sections) {
    const item = section.items.find((i) => i.match(pathname));
    if (item) return { section, item };
  }
  return { section: null, item: null };
}
