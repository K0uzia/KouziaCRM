export type Commune = {
  nom: string;
  code: string;
  codesPostaux: string[];
};

export type AdresseSuggestion = {
  label: string;
  /** Numéro + type + voie (sans CP/ville) */
  name: string;
  housenumber: string | null;
  street: string | null;
  postcode: string;
  city: string;
  citycode: string;
  lat: number;
  lon: number;
  score: number;
};

export type ValidatedAddress = {
  addressLine1: string;
  postalCode: string;
  city: string;
  citycode: string;
  lat: number;
  lon: number;
  score: number;
  label: string;
};

export type AddressValidationResult =
  | { status: "ok"; address: ValidatedAddress }
  | { status: "ambiguous"; suggestions: AdresseSuggestion[] }
  | { status: "not_found" }
  | { status: "unavailable" };

/** Seuil de score BAN au-delà duquel on normalise silencieusement. */
export const ADDRESS_SCORE_HIGH = 0.7;

/** Score minimal pour considérer une suggestion comme candidate. */
export const ADDRESS_SCORE_MIN = 0.4;
