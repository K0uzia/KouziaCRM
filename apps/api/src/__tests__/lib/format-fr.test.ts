import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDateFr,
  formatDateTimeLongFr,
  formatDateTimeShortFr,
  formatDayMonthShortFr,
  formatEUR,
  formatLongDateFr,
  formatMonthYearShortFr,
  intlDataStatus,
  parisYmd,
} from "@/lib/format-fr.js";

const NBSP = " ";
const TZ = "Europe/Paris";
// Référence : Intl fr-FR de ce poste (données ICU complètes), espaces fines ramenées à l'insécable comme avant.
const intlEUR = (cents: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100).replace(/[  ]/g, NBSP);

const AMOUNTS = [0, 1, 99, 100, 119000, 99999, 100000, 123456789, 100000000000, -5000, -119000, 7];
// Heures d'été et d'hiver, minuit à Paris, changements d'heure, fin d'année, 1er du mois.
const DATES = [
  "2026-10-19T12:34:00Z",
  "2026-10-24T22:30:00Z",
  "2026-10-25T00:59:00Z",
  "2026-10-25T01:00:00Z",
  "2026-03-29T00:59:00Z",
  "2026-03-29T01:00:00Z",
  "2026-12-31T23:00:00Z",
  "2026-12-31T22:59:00Z",
  "2026-02-28T23:30:00Z",
  "2027-01-01T00:00:00Z",
  "2026-06-30T22:00:00Z",
].map((s) => new Date(s));

describe("formateurs français déterministes : identiques à Intl fr-FR sur un hôte complet", () => {
  it("montants : « 1 190,00 € », milliers et symbole à l'espace insécable", () => {
    expect(formatEUR(119000)).toBe(`1${NBSP}190,00${NBSP}€`);
    for (const c of AMOUNTS) expect(formatEUR(c)).toBe(intlEUR(c));
  });

  it("dates et heures à Paris, mois en toutes lettres, changements d'heure compris", () => {
    for (const d of DATES) {
      expect(formatDateFr(d)).toBe(d.toLocaleDateString("fr-FR", { timeZone: TZ }));
      expect(formatLongDateFr(d)).toBe(d.toLocaleDateString("fr-FR", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" }));
      expect(formatDayMonthShortFr(d)).toBe(d.toLocaleDateString("fr-FR", { timeZone: TZ, day: "numeric", month: "short" }));
      expect(formatMonthYearShortFr(d)).toBe(d.toLocaleDateString("fr-FR", { timeZone: TZ, month: "short", year: "2-digit" }));
      expect(formatDateTimeLongFr(d)).toBe(d.toLocaleString("fr-FR", { timeZone: TZ, dateStyle: "long", timeStyle: "short" }));
      expect(formatDateTimeShortFr(d)).toBe(
        new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(d).replace(" ", " à "),
      );
      expect(parisYmd(d)).toBe(new Intl.DateTimeFormat("fr-CA", { timeZone: TZ }).format(d));
    }
  });

  it("hôte complet : données de langue signalées « complet »", () => {
    expect(intlDataStatus().status).toBe("complet");
  });
});

describe("hôte sans données françaises (Alpine, icu-data-en seul)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("le français retombe sur l'anglais, les formateurs de l'ERP ne bougent pas, l'état devient « incomplet »", () => {
    const Real = Intl;
    const en = (locales?: string | string[]) => (Array.isArray(locales) ? locales : [locales]).map((l) => (l && !l.startsWith("en") ? "en-US" : l)) as string[];
    vi.stubGlobal("Intl", {
      ...Real,
      NumberFormat: function (locales?: string | string[], o?: Intl.NumberFormatOptions) {
        return new Real.NumberFormat(en(locales), o);
      },
      DateTimeFormat: function (locales?: string | string[], o?: Intl.DateTimeFormatOptions) {
        return new Real.DateTimeFormat(en(locales), o);
      },
    });
    const toLocale = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function (locales?: string | string[], o?: Intl.DateTimeFormatOptions) {
      return toLocale.call(this, en(locales), o);
    };
    try {
      // Symptôme vu par Alexandre : le symbole avant le montant.
      expect(new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(1190)).toBe("€1,190.00");
      expect(formatEUR(119000)).toBe(`1${NBSP}190,00${NBSP}€`);
      expect(formatLongDateFr(new Date("2026-10-19T12:00:00Z"))).toBe("19 octobre 2026");
      expect(formatDateFr(new Date("2026-10-19T12:00:00Z"))).toBe("19/10/2026");
      expect(formatDateTimeLongFr(new Date("2026-10-19T12:34:00Z"))).toBe("19 octobre 2026 à 14:34");
      expect(intlDataStatus()).toMatchObject({ status: "incomplet", sample: "€1,190.00" });
    } finally {
      Date.prototype.toLocaleDateString = toLocale;
    }
  });
});
