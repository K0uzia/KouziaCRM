/**
 * Montants et dates en français, sans dépendre des données de langue (ICU) de l'hôte.
 *
 * Sur Alpine, Node utilise l'ICU du système, qui n'installe par défaut que les locales en_US et en_GB
 * (paquet icu-data-en ; icu-data-full est optionnel). « fr-FR » y retombe sur l'anglais sans erreur :
 * « €1,190.00 », « 10/19/2026 », « October ». Tout ce qui part dans un PDF, un e-mail ou un export passe donc
 * par ces fonctions : le texte français est écrit ici, et seules les parties numériques de la date à Paris sont
 * demandées à Intl (formatToParts en en-US), qui ne dépendent que des fuseaux horaires, présents dans toutes
 * les données ICU (icu-data-en les garde). Résultat identique à Intl fr-FR sur un hôte complet (testé).
 */

const NBSP = " ";
export const BUSINESS_TZ = "Europe/Paris";

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MONTHS_SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** Montant en centimes : « 1 190,00 € » (milliers et symbole séparés par une espace insécable). */
export function formatEUR(cents: number): string {
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  const euros = Math.floor(abs / 100);
  const centimes = String(abs % 100).padStart(2, "0");
  const grouped = String(euros).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${rounded < 0 ? "-" : ""}${grouped},${centimes}${NBSP}€`;
}

type ParisParts = { year: number; month: number; day: number; hour: number; minute: number };

let partsFormatter: Intl.DateTimeFormat | null = null;

/** Année, mois, jour, heure et minute à Paris (heure d'été comprise). */
export function parisParts(date: Date): ParisParts {
  partsFormatter ??= new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const p: Record<string, number> = {};
  for (const part of partsFormatter.formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute! };
}

const two = (n: number) => String(n).padStart(2, "0");

/** « 19/10/2026 » (jour à Paris). */
export function formatDateFr(date: Date): string {
  const { year, month, day } = parisParts(date);
  return `${two(day)}/${two(month)}/${year}`;
}

/** « 19 octobre 2026 ». */
export function formatLongDateFr(date: Date): string {
  const { year, month, day } = parisParts(date);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** « 19 oct. ». */
export function formatDayMonthShortFr(date: Date): string {
  const { month, day } = parisParts(date);
  return `${day} ${MONTHS_SHORT[month - 1]}`;
}

/** « oct. 26 ». */
export function formatMonthYearShortFr(date: Date): string {
  const { year, month } = parisParts(date);
  return `${MONTHS_SHORT[month - 1]} ${two(year % 100)}`;
}

/** « 19 octobre 2026 à 14:32 ». */
export function formatDateTimeLongFr(date: Date): string {
  const { hour, minute } = parisParts(date);
  return `${formatLongDateFr(date)} à ${two(hour)}:${two(minute)}`;
}

/** « 19/10/2026 à 14:32 ». */
export function formatDateTimeShortFr(date: Date): string {
  const { hour, minute } = parisParts(date);
  return `${formatDateFr(date)} à ${two(hour)}:${two(minute)}`;
}

/** « 2026-10-19 » : jour calendaire à Paris. */
export function parisYmd(date: Date): string {
  const { year, month, day } = parisParts(date);
  return `${year}-${two(month)}-${two(day)}`;
}

/**
 * Données de langue de l'hôte : « complet » si Intl sait le français (icu-data-full), sinon « incomplet ».
 * N'affecte pas les documents (formateurs ci-dessus), mais signale un serveur mal équipé.
 */
export function intlDataStatus(): { status: "complet" | "incomplet"; sample: string } {
  let sample = "";
  try {
    sample = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" })
      .format(1190)
      .replace(/[  ]/g, NBSP);
    const month = new Date(Date.UTC(2026, 9, 15)).toLocaleDateString("fr-FR", { month: "long", timeZone: "UTC" });
    const ok = sample === formatEUR(119000) && month === "octobre";
    return { status: ok ? "complet" : "incomplet", sample };
  } catch {
    return { status: "incomplet", sample };
  }
}
