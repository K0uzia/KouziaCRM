/**
 * Date de début d'activité (paramètres entreprise) : parsing local et règles métier
 * CFE, URSSAF, réserves trésorerie.
 */

/** Parse une date ISO `YYYY-MM-DD` en date locale (midi, évite le décalage UTC). */
export function parseBusinessStartDateInput(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return new Date(value);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

/** Normalise une date Prisma en date civile locale (minuit). */
export function toBusinessStartLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function getBusinessStartLocal(
  businessStartDate: Date | null | undefined,
): Date | null {
  if (!businessStartDate) return null;
  return toBusinessStartLocal(businessStartDate);
}

/** L'activité a-t-elle commencé à la date `ref` (fin de journée) ? */
export function hasActivityStarted(
  businessStartDate: Date | null | undefined,
  ref: Date = new Date(),
): boolean {
  const start = getBusinessStartLocal(businessStartDate);
  if (!start) return false;
  const refDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 23, 59, 59, 999);
  return refDay.getTime() >= start.getTime();
}

/**
 * Mois d'activité dans une année civile (1 à 12), à partir du mois de création inclus.
 * Ex. création 15/09/2026 → 4 mois en 2026 (sept. à déc.).
 */
export function monthsActiveInCalendarYear(
  businessStart: Date,
  year: number,
): number {
  const start = toBusinessStartLocal(businessStart);
  if (year < start.getFullYear()) return 0;
  if (year > start.getFullYear()) return 12;
  return Math.max(1, 12 - start.getMonth());
}

/**
 * Borne [start, end] à partir de la date de début d'activité.
 * Retourne null si la période est entièrement avant le début.
 */
export function clipPeriodToActivity(
  start: Date,
  end: Date,
  businessStartDate: Date | null | undefined,
): { start: Date; end: Date } | null {
  const activityStart = getBusinessStartLocal(businessStartDate);
  if (!activityStart) return { start, end };
  if (end.getTime() < activityStart.getTime()) return null;
  const clippedStart =
    start.getTime() < activityStart.getTime() ? activityStart : start;
  return { start: clippedStart, end };
}

/** Début d'activité applicable pour une année civile et une période [fin]. */
export function resolveActivityStartForYear(
  businessStartDate: Date | null | undefined,
  year: number,
  periodEnd: Date,
): Date | null {
  const activityStart = getBusinessStartLocal(businessStartDate);
  const yearStart = new Date(year, 0, 1, 0, 0, 0, 0);
  if (!activityStart) return null;
  if (periodEnd.getTime() < activityStart.getTime()) return null;
  if (activityStart.getFullYear() > year) return null;
  return activityStart.getTime() > yearStart.getTime() ? activityStart : yearStart;
}

/**
 * Montant CFE à payer pour l'échéance de décembre `paymentYear`.
 * null si pas de date de début ou activité pas encore commencée pour cette échéance.
 */
export function cfeAmountForPaymentYear(
  cfeAmountCents: number,
  businessStartDate: Date | null | undefined,
  paymentYear: number,
): number | null {
  const start = getBusinessStartLocal(businessStartDate);
  if (!start || cfeAmountCents <= 0) return null;
  if (paymentYear < start.getFullYear()) return null;

  if (paymentYear === start.getFullYear()) {
    const months = monthsActiveInCalendarYear(start, paymentYear);
    return Math.round((cfeAmountCents * months) / 12);
  }
  return cfeAmountCents;
}

/** Mois écoulés depuis le début d'activité jusqu'à `periodEnd` (inclus), plafonné à 12. */
export function monthsElapsedSinceActivityStart(
  businessStartDate: Date | null | undefined,
  periodEnd: Date,
): number {
  const start = getBusinessStartLocal(businessStartDate);
  if (!start) return 0;
  if (periodEnd.getTime() < start.getTime()) return 0;

  const months =
    (periodEnd.getFullYear() - start.getFullYear()) * 12 +
    (periodEnd.getMonth() - start.getMonth()) +
    1;
  return Math.min(12, Math.max(0, months));
}

/** Format `YYYY-MM-DD` pour l'API et les champs date HTML (évite le décalage UTC). */
export function formatBusinessStartDateForApi(
  businessStartDate: Date | null | undefined,
): string | null {
  const start = getBusinessStartLocal(businessStartDate);
  if (!start) return null;
  const y = start.getFullYear();
  const m = String(start.getMonth() + 1).padStart(2, "0");
  const d = String(start.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
