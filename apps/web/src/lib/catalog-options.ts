import { formatEUR } from "@/lib/format";
import { periodSuffix } from "@/lib/billing-interval";
import type { ComboboxGroup, ComboboxOption } from "@/lib/combobox-filter";

/** Prestation du catalogue telle que la renvoie /api/services. */
export type CatalogService = {
  id: string;
  name: string;
  description?: string | null;
  unitPriceCents: number;
  isSubscription?: boolean;
  isPack?: boolean;
  billingInterval?: string | null;
  /** Prestation ponctuelle : SITE, LOGICIEL ou OPTION ; null = non classée. */
  category?: string | null;
};

const ONE_OFF_GROUPS = [
  { category: "SITE", heading: "Sites" },
  { category: "LOGICIEL", heading: "Logiciels" },
  { category: "OPTION", heading: "Options" },
] as const;

export function catalogOption(s: CatalogService): ComboboxOption {
  return {
    value: s.id,
    label: s.name,
    meta: formatEUR(s.unitPriceCents),
    metaDetail: s.isSubscription ? periodSuffix(s.billingInterval) : s.isPack ? "pack" : "prix fixe",
    description: s.description?.trim() || null,
  };
}

/**
 * Catalogue en groupes titrés, dans l'ordre de lecture d'un devis : Sites, Logiciels, Options, autres
 * prestations ponctuelles, Packs, Abonnements. Un groupe sans prestation n'apparaît pas.
 */
export function catalogGroups(services: CatalogService[]): ComboboxGroup[] {
  const oneOff = services.filter((s) => !s.isSubscription && !s.isPack);
  const classified = new Set<string>(ONE_OFF_GROUPS.map((g) => g.category));
  const groups: ComboboxGroup[] = [
    ...ONE_OFF_GROUPS.map((g) => ({
      heading: g.heading,
      options: oneOff.filter((s) => s.category === g.category).map(catalogOption),
    })),
    {
      heading: "Autres prestations",
      options: oneOff.filter((s) => !s.category || !classified.has(s.category)).map(catalogOption),
    },
    { heading: "Packs", options: services.filter((s) => s.isPack).map(catalogOption) },
    { heading: "Abonnements", options: services.filter((s) => s.isSubscription).map(catalogOption) },
  ];
  return groups.filter((g) => g.options.length > 0);
}
