import { isValidSiren, isValidSiret } from "./luhn.js";

export type SirenSiretKind = "siren" | "siret" | "invalid";

/** Retire espaces et caractères non numériques. */
export function normalizeDigits(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Analyse une saisie SIREN (9) ou SIRET (14).
 * Retourne le SIREN dérivé (9 premiers chiffres du SIRET).
 */
export function parseSirenOrSiret(input: string): {
  kind: SirenSiretKind;
  digits: string;
  siren: string | null;
  siret: string | null;
} {
  const digits = normalizeDigits(input);
  if (digits.length === 9 && isValidSiren(digits)) {
    return { kind: "siren", digits, siren: digits, siret: null };
  }
  if (digits.length === 14 && isValidSiret(digits)) {
    return {
      kind: "siret",
      digits,
      siren: digits.slice(0, 9),
      siret: digits,
    };
  }
  return { kind: "invalid", digits, siren: null, siret: null };
}

/** Message d'erreur utilisateur pour une saisie invalide. */
export function sirenSiretErrorMessage(input: string): string | null {
  const digits = normalizeDigits(input);
  if (!digits) return null;
  if (digits.length < 9) return "SIREN incomplet (9 chiffres) ou SIRET (14 chiffres)";
  if (digits.length === 9 && !isValidSiren(digits)) {
    return "SIREN invalide (contrôle Luhn échoué)";
  }
  if (digits.length > 9 && digits.length < 14) {
    return "SIRET incomplet (14 chiffres)";
  }
  if (digits.length === 14 && !isValidSiret(digits)) {
    return "SIRET invalide (contrôle Luhn échoué)";
  }
  if (digits.length > 14) return "Trop de chiffres (SIREN 9 ou SIRET 14)";
  return null;
}
