/**
 * Droit de rétractation du consommateur (contrat à distance, art. L221-18 du Code de la
 * consommation ; CGV art. 9) : 14 jours à compter du jour de la signature, prolongés jusqu'au
 * premier jour ouvrable quand le dernier jour tombe un samedi, un dimanche ou un jour férié.
 * Dates calculées à l'heure de Paris.
 */

const TZ = "Europe/Paris";
export const WITHDRAWAL_DAYS = 14;

type Ymd = { y: number; m: number; d: number };

function ymdInParis(date: Date): Ymd {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

function addDays({ y, m, d }: Ymd, days: number): Ymd {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const key = ({ y, m, d }: Ymd) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Dimanche de Pâques (algorithme de Meeus, Jones et Butcher, calendrier grégorien). */
function easterSunday(y: number): Ymd {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y, m: month, d: day };
}

/**
 * Jours fériés légaux en métropole (art. L3133-1 du Code du travail). Calcul local plutôt
 * qu'une bibliothèque de calendriers : onze dates, dont trois liées à Pâques.
 */
export function frenchPublicHolidays(y: number): Set<string> {
  const easter = easterSunday(y);
  return new Set([
    `${y}-01-01`,
    key(addDays(easter, 1)), // lundi de Pâques
    `${y}-05-01`,
    `${y}-05-08`,
    key(addDays(easter, 39)), // Ascension
    key(addDays(easter, 50)), // lundi de Pentecôte
    `${y}-07-14`,
    `${y}-08-15`,
    `${y}-11-01`,
    `${y}-11-11`,
    `${y}-12-25`,
  ]);
}

function isWorkingDay(day: Ymd): boolean {
  const weekday = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !frenchPublicHolidays(day.y).has(key(day));
}

/** Instant de fin de journée (23:59:59.999) à Paris pour ce jour. */
function endOfParisDay(day: Ymd): Date {
  const utcGuess = Date.UTC(day.y, day.m - 1, day.d, 23, 59, 59, 999);
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(new Date(utcGuess))
    .find((p) => p.type === "timeZoneName")?.value;
  const hours = Number(/GMT([+-]\d+)/.exec(offset ?? "")?.[1] ?? 0);
  return new Date(utcGuess - hours * 3_600_000);
}

/** Dernier instant du délai de rétractation pour un contrat signé à `signedAt`. */
export function withdrawalEndsAt(signedAt: Date): Date {
  let last = addDays(ymdInParis(signedAt), WITHDRAWAL_DAYS);
  while (!isWorkingDay(last)) last = addDays(last, 1);
  return endOfParisDay(last);
}

/** Premier instant où les travaux (ou la 1re période d'abonnement) peuvent commencer. */
export function startAfterWithdrawal(endsAt: Date): Date {
  return new Date(endsAt.getTime() + 1);
}
