export { MemoryCache, TTL, sharedCache } from "./cache/memory-cache.js";
export { luhnCheck, isValidSiren, isValidSiret } from "./validation/luhn.js";
export {
  normalizeDigits,
  parseSirenOrSiret,
  sirenSiretErrorMessage,
  type SirenSiretKind,
} from "./validation/siren-siret.js";
export {
  ADDRESS_SCORE_HIGH,
  ADDRESS_SCORE_MIN,
  type Commune,
  type AdresseSuggestion,
  type ValidatedAddress,
  type AddressValidationResult,
} from "./geo/types.js";
export { fetchCommunesByPostalCode } from "./geo/communes.js";
export {
  searchAdresses,
  validateAdresse,
  suggestionToValidated,
} from "./geo/adresse.js";
export {
  lookupEntreprise,
  type EntrepriseLookupResult,
  type LookupEntrepriseOptions,
} from "./entreprise/lookup.js";
