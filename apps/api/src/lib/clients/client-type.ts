/** Types de client : particulier (consommateur), professionnel, association (non-professionnel). */
export const CLIENT_TYPES = ["B2B", "B2C", "ASSOCIATION"] as const;
export type ClientTypeValue = (typeof CLIENT_TYPES)[number];

/** Personne morale (professionnel ou association) : raison sociale, SIREN facultatif, signature « au nom de ». */
export function isOrganization(type: string | null | undefined): boolean {
  return type === "B2B" || type === "ASSOCIATION";
}

/** Catégorie juridique INSEE d'une association (92xx : association déclarée, reconnue d'utilité publique…). */
export function isAssociationCategory(code: string | null | undefined): boolean {
  return typeof code === "string" && /^92\d{2}$/.test(code);
}
