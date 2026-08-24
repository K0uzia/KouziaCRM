/**
 * Bornes calendaires locales (Europe/Paris côté serveur = TZ machine).
 * Évite les pièges UTC / fin de mois (31, 28/29 fév).
 */

export type MonthRef = {
  /** Année civile */
  year: number;
  /** Mois 1–12 */
  month: number;
  /** Premier jour 00:00:00.000 */
  start: Date;
  /** Dernier jour 23:59:59.999 */
  end: Date;
};

const MONTH_NAMES_FR = [
  "janvier",
  "février",
  "mars",
  "avril",
  "mai",
  "juin",
  "juillet",
  "août",
  "septembre",
  "octobre",
  "novembre",
  "décembre",
] as const;

export function monthLabelFr(year: number, month: number): string {
  return `${MONTH_NAMES_FR[month - 1]} ${year}`;
}

/** Bornes [1er, dernier] du mois `month` (1–12) de `year`. */
export function monthBounds(year: number, month: number): MonthRef {
  if (month < 1 || month > 12) {
    throw new Error(`Mois invalide: ${month}`);
  }
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  // jour 0 du mois suivant = dernier jour du mois courant
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { year, month, start, end };
}

export function currentMonth(ref: Date = new Date()): MonthRef {
  return monthBounds(ref.getFullYear(), ref.getMonth() + 1);
}

/** Mois précédent strict (janvier → décembre N-1). */
export function previousMonth(ref: Date = new Date()): MonthRef {
  const y = ref.getFullYear();
  const m = ref.getMonth() + 1; // 1-12 courant
  if (m === 1) return monthBounds(y - 1, 12);
  return monthBounds(y, m - 1);
}

export function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Jours calendaires entre a et b (b - a). Négatif si a > b. */
export function calendarDaysBetween(from: Date, to: Date): number {
  const a = startOfLocalDay(from).getTime();
  const b = startOfLocalDay(to).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Échéance de paiement des cotisations du mois M-1 :
 * le `deadlineDay` du mois courant M (ex: 5 août pour juillet).
 */
export function urssafDeadlineForCurrentMonth(
  ref: Date = new Date(),
  deadlineDay = 5,
): Date {
  const day = Math.min(28, Math.max(1, deadlineDay));
  return new Date(ref.getFullYear(), ref.getMonth(), day, 23, 59, 59, 999);
}
