/** Types de client : mêmes valeurs que l'API (ClientType). */
export type ClientType = "B2B" | "B2C" | "ASSOCIATION";

export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  B2C: "Particulier",
  B2B: "Professionnel",
  ASSOCIATION: "Association",
};

/** Libellé court (cartes de liste). */
export const CLIENT_TYPE_SHORT: Record<ClientType, string> = {
  B2C: "Particulier",
  B2B: "Pro",
  ASSOCIATION: "Association",
};

export const CLIENT_TYPE_TONE: Record<ClientType, "neutral" | "violet" | "teal"> = {
  B2C: "neutral",
  B2B: "violet",
  ASSOCIATION: "teal",
};

/** Personne morale (professionnel ou association) : nom de la structure et SIREN facultatif. */
export function isOrganization(type: string | null | undefined): boolean {
  return type === "B2B" || type === "ASSOCIATION";
}
