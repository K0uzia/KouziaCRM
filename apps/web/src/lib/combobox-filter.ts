/** Option d'une liste de choix (primitive Combobox). */
export type ComboboxOption = {
  value: string;
  label: string;
  /** À droite du nom : prix, numéro de client. */
  meta?: string;
  /** Sous `meta` : périodicité (« / an », « prix fixe »). */
  metaDetail?: string;
  /** Ligne secondaire, tronquée à une ligne. */
  description?: string | null;
  /** Termes cherchés en plus du texte affiché. */
  keywords?: string;
  disabled?: boolean;
};

/** Groupe titré ; un titre vide affiche les options sans en-tête (liste à un seul groupe). */
export type ComboboxGroup = { heading: string; options: ComboboxOption[] };

/** Clé de recherche : minuscules, sans accents ni espaces superflus (« Écran » trouve « ecran »). */
export function searchKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Groupes réduits aux options dont le texte contient chacun des mots cherchés, dans n'importe quel ordre.
 * Recherche par inclusion plutôt que le score flou de cmdk : un identifiant ou un prix ne remonte pas
 * une option sans rapport. Les groupes vides disparaissent.
 */
export function filterGroups(groups: ComboboxGroup[], query: string): ComboboxGroup[] {
  const words = searchKey(query).split(" ").filter(Boolean);
  if (words.length === 0) return groups.filter((g) => g.options.length > 0);
  return groups
    .map((g) => ({
      ...g,
      options: g.options.filter((o) => {
        const hay = searchKey([o.label, o.meta, o.metaDetail, o.description, o.keywords, g.heading].filter(Boolean).join(" "));
        return words.every((w) => hay.includes(w));
      }),
    }))
    .filter((g) => g.options.length > 0);
}

export function findOption(groups: ComboboxGroup[], value: string | null | undefined): ComboboxOption | undefined {
  if (!value) return undefined;
  for (const g of groups) {
    const found = g.options.find((o) => o.value === value);
    if (found) return found;
  }
  return undefined;
}

export function countOptions(groups: ComboboxGroup[]): number {
  return groups.reduce((n, g) => n + g.options.length, 0);
}
