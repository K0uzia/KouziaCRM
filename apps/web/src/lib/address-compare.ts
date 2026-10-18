/**
 * Comparaisons d'adresse sans tenir compte de la casse, des accents, de la ponctuation ni des espaces :
 * « Saint-Caprais-De-Bordeaux » et « Saint-Caprais-de-Bordeaux » désignent la même commune, mais
 * « 3 chemin de Recette » et « 3 Chemin de Caucetey » sont deux voies différentes.
 */
export function normalizeAddressText(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function sameAddressText(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeAddressText(a) === normalizeAddressText(b);
}

/** Commune officielle qui correspond à la ville saisie (même nom à la casse et aux accents près), sinon null. */
export function matchCommune<T extends { nom: string }>(city: string, communes: T[]): T | null {
  if (!city.trim()) return null;
  return communes.find((c) => sameAddressText(c.nom, city)) ?? null;
}

type AddressFields = {
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
};

/** Adresse modifiée dans le formulaire par rapport à la fiche ouverte (« Modifier ») ? */
export function addressChanged(form: AddressFields, initial: AddressFields | null | undefined): boolean {
  if (!initial) return true;
  return (["addressLine1", "addressLine2", "postalCode", "city", "country"] as const).some(
    (k) => (form[k] ?? "").trim() !== (initial[k] ?? "").trim(),
  );
}
