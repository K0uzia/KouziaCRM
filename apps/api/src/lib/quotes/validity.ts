import { parisParts, parisWallTime } from "@/lib/format-fr.js";

/** Durée de validité par défaut d'un devis, en jours. */
export const QUOTE_VALIDITY_DAYS = 30;

/**
 * Validité de devis saisie « AAAA-MM-JJ » : jusqu'à la fin de ce jour à Paris (audit du 27/10/2026). new Date() la
 * plaçait à minuit UTC, soit 1 h ou 2 h du matin : le devis expirait au début de son dernier jour affiché.
 */
export function validityEnd(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? parisWallTime(Number(m[1]), Number(m[2]), Number(m[3]), 23, 59, 59_999) : new Date(value);
}

/** Validité par défaut : fin du 30e jour (23:59:59,999 heure de Paris) après la date donnée, comme une date saisie. */
export function defaultQuoteValidUntil(from: Date = new Date()): Date {
  const p = parisParts(from);
  // Jour civil de Paris + 30 : Date.UTC normalise le débordement de mois et d'année.
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + QUOTE_VALIDITY_DAYS));
  return parisWallTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 23, 59, 59_999);
}
