import { prisma } from "@/lib/prisma";
import { getCompanySettings } from "@/lib/company";
import { computeSocialChargesForEncaisse } from "@/lib/publicodes";
import { monthBounds, monthLabelFr } from "@/lib/finance/dates";
import {
  getBusinessStartLocal,
  monthsElapsedSinceActivityStart,
  resolveActivityStartForYear,
} from "@/lib/company/business-start";

export type CashflowScope = "week" | "month" | "quarter" | "year";

export const CASHFLOW_SCOPES: CashflowScope[] = ["week", "month", "quarter", "year"];

export function isCashflowScope(v: unknown): v is CashflowScope {
  return typeof v === "string" && (CASHFLOW_SCOPES as string[]).includes(v);
}

export type CashflowPeriod = {
  scope: CashflowScope;
  start: Date;
  end: Date;
  label: string;
  key: string;
};

/** Lundi 00:00 locale de la semaine contenant `ref`. */
export function startOfIsoWeek(ref: Date): Date {
  const day = ref.getDay(); // 0 = dimanche
  const offset = day === 0 ? 6 : day - 1;
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - offset, 0, 0, 0, 0);
}

export function endOfIsoWeek(ref: Date): Date {
  const start = startOfIsoWeek(ref);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6, 23, 59, 59, 999);
}

/** Trimestre civil (1–4) contenant `ref`. */
export function currentQuarterBounds(ref: Date = new Date()): {
  year: number;
  quarter: number;
  start: Date;
  end: Date;
} {
  const year = ref.getFullYear();
  const quarter = Math.floor(ref.getMonth() / 3) + 1;
  const startMonth = (quarter - 1) * 3;
  return {
    year,
    quarter,
    start: new Date(year, startMonth, 1, 0, 0, 0, 0),
    end: new Date(year, startMonth + 3, 0, 23, 59, 59, 999),
  };
}

/**
 * Bornes [start, end] selon le toggle Semaine / Mois / Trimestre / Année.
 *  -  Semaine : semaine ISO (lun–dim) courante
 *  -  Mois : mois civil courant
 *  -  Trimestre : trimestre civil courant (3 mois)
 *  -  Année : année civile courante
 */
export function resolveCashflowPeriod(
  scope: CashflowScope,
  now: Date = new Date(),
): CashflowPeriod {
  switch (scope) {
    case "week": {
      const start = startOfIsoWeek(now);
      const end = endOfIsoWeek(now);
      const key = `${start.getFullYear()}-W${String(isoWeekNumber(start)).padStart(2, "0")}`;
      return {
        scope,
        start,
        end,
        key,
        label: `Semaine du ${start.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}`,
      };
    }
    case "month": {
      const m = monthBounds(now.getFullYear(), now.getMonth() + 1);
      return {
        scope,
        start: m.start,
        end: m.end,
        key: `${m.year}-${String(m.month).padStart(2, "0")}`,
        label: monthLabelFr(m.year, m.month),
      };
    }
    case "quarter": {
      const q = currentQuarterBounds(now);
      return {
        scope,
        start: q.start,
        end: q.end,
        key: `${q.year}-Q${q.quarter}`,
        label: `T${q.quarter} ${q.year}`,
      };
    }
    case "year": {
      const year = now.getFullYear();
      return {
        scope,
        start: new Date(year, 0, 1, 0, 0, 0, 0),
        end: new Date(year, 11, 31, 23, 59, 59, 999),
        key: String(year),
        label: String(year),
      };
    }
  }
}

function isoWeekNumber(d: Date): number {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil(((tmp.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Somme des paiements encaissés sur [start, end]. */
export async function sumEncaisseCents(start: Date, end: Date): Promise<number> {
  const agg = await prisma.payment.aggregate({
    where: { paidAt: { gte: start, lte: end } },
    _sum: { amountCents: true },
  });
  return agg._sum.amountCents ?? 0;
}

/** CFE annuelle proratisée sur la durée de la période [start, end]. */
export function computeCfeProrataCents(
  cfeAmountCents: number,
  start: Date,
  end: Date,
): number {
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  return Math.round((cfeAmountCents * days) / 365);
}

/**
 * Début d'activité pour la réserve CFE : uniquement si renseignée dans les paramètres.
 */
function resolveCfeActivityStart(
  businessStartDate: Date | null | undefined,
  year: number,
  periodEnd: Date,
): Date | null {
  return resolveActivityStartForYear(businessStartDate, year, periodEnd);
}

/**
 * Réserve CFE intelligente :
 * - 0 € si aucun encaissement sur la période (mois creux)
 * - sinon, rattrapage YTD : objectif cumulé (CFE × mois écoulés / 12)
 *   moins ce qui a déjà été provisionné sur les mois actifs précédents.
 * Ainsi un mois d'activité après des mois creux met de côté assez pour payer en fin d'année.
 */
export function computeCfeReserveForWindows(
  cfeAmountCents: number,
  windows: Array<{ start: Date; end: Date; encaisseCents: number }>,
  year: number,
  businessStartDate?: Date | null,
): number[] {
  if (cfeAmountCents <= 0 || windows.length === 0) {
    return windows.map(() => 0);
  }

  const lastEnd = windows[windows.length - 1]!.end;
  const activityStart = resolveCfeActivityStart(businessStartDate, year, lastEnd);
  if (!activityStart) return windows.map(() => 0);

  let reservedYtd = 0;
  return windows.map(({ end, encaisseCents }) => {
    if (encaisseCents <= 0) return 0;
    if (end.getTime() < activityStart.getTime()) return 0;

    const monthsElapsed = monthsElapsedSinceActivityStart(businessStartDate, end);
    if (monthsElapsed <= 0) return 0;

    const targetYtd = Math.round((cfeAmountCents * monthsElapsed) / 12);
    const provision = Math.max(0, targetYtd - reservedYtd);
    reservedYtd += provision;
    return provision;
  });
}

/** Réserve CFE pour une seule période (avec historique YTD des encaissements mensuels). */
export async function computeCfeReserveCents(opts: {
  cfeAmountCents: number;
  encaisseCents: number;
  periodStart: Date;
  periodEnd: Date;
  now?: Date;
  businessStartDate?: Date | null;
}): Promise<number> {
  if (opts.encaisseCents <= 0 || opts.cfeAmountCents <= 0) return 0;
  if (!getBusinessStartLocal(opts.businessStartDate)) return 0;

  const now = opts.now ?? new Date();
  const year = opts.periodEnd.getFullYear();
  const activityStart = resolveCfeActivityStart(
    opts.businessStartDate,
    year,
    opts.periodEnd,
  );
  if (!activityStart) return 0;

  const payments = await prisma.payment.findMany({
    where: {
      paidAt: {
        gte: activityStart,
        lte: opts.periodEnd,
      },
    },
    select: { amountCents: true, paidAt: true },
  });

  const monthKeys: string[] = [];
  const cursor = new Date(activityStart.getFullYear(), activityStart.getMonth(), 1);
  const last = new Date(opts.periodEnd.getFullYear(), opts.periodEnd.getMonth(), 1);
  while (cursor.getTime() <= last.getTime()) {
    monthKeys.push(`${cursor.getFullYear()}-${cursor.getMonth()}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const byMonth = new Map<string, number>();
  for (const key of monthKeys) byMonth.set(key, 0);
  for (const p of payments) {
    const key = `${p.paidAt.getFullYear()}-${p.paidAt.getMonth()}`;
    if (byMonth.has(key)) {
      byMonth.set(key, (byMonth.get(key) ?? 0) + p.amountCents);
    }
  }

  const windows = monthKeys.map((key) => {
    const [y, m] = key.split("-").map(Number) as [number, number];
    const b = monthBounds(y, m + 1);
    return {
      start: b.start,
      end: b.end,
      encaisseCents: byMonth.get(key) ?? 0,
    };
  });

  const reserves = computeCfeReserveForWindows(
    opts.cfeAmountCents,
    windows,
    year,
    opts.businessStartDate,
  );
  return reserves[reserves.length - 1] ?? 0;
}

export type ScopedCashflow = {
  scope: CashflowScope;
  periodLabel: string;
  periodKey: string;
  year: number;
  month: number;
  totalEncaisseCents: number;
  urssafCents: number;
  urssafEffectiveBps: number;
  /** Enveloppe trésorerie entreprise (% encaissements, réglages). */
  fraisCents: number;
  fraisBps: number;
  placementsCents: number;
  placementsBps: number;
  /** CFE prorata sur la période. */
  cfeCents: number;
  /** Trésorerie = enveloppe entreprise + placements. */
  tresorerieCents: number;
  /** Trésorerie + CFE (réserves hors URSSAF). */
  tresorerieEtCfeCents: number;
  reservedCents: number;
  resteNetCents: number;
  social: ReturnType<typeof computeSocialChargesForEncaisse>;
};

/** Répartition waterfall à partir d'un montant encaissé (Publicodes + taux company). */
export function buildCashflowFromEncaisse(
  encaisseCents: number,
  meta: {
    scope: CashflowScope;
    periodLabel: string;
    periodKey: string;
    now?: Date;
    treasuryRateBps: number;
    placementRateBps: number;
    cfeCents?: number;
  },
): ScopedCashflow {
  const now = meta.now ?? new Date();
  const encaisse = Math.max(0, Math.round(encaisseCents));
  const social = computeSocialChargesForEncaisse(encaisse);
  const fraisCents = Math.round((encaisse * meta.treasuryRateBps) / 10_000);
  const placementsCents = Math.round((encaisse * meta.placementRateBps) / 10_000);
  const cfeCents = Math.max(0, meta.cfeCents ?? 0);
  const tresorerieCents = fraisCents + placementsCents;
  const tresorerieEtCfeCents = tresorerieCents + cfeCents;
  const urssafCents = social.totalCents;
  const reservedCents = urssafCents + tresorerieEtCfeCents;

  return {
    scope: meta.scope,
    periodLabel: meta.periodLabel,
    periodKey: meta.periodKey,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    totalEncaisseCents: encaisse,
    urssafCents,
    urssafEffectiveBps: social.effectiveRateBps,
    fraisCents,
    fraisBps: meta.treasuryRateBps,
    placementsCents,
    placementsBps: meta.placementRateBps,
    cfeCents,
    tresorerieCents,
    tresorerieEtCfeCents,
    reservedCents,
    resteNetCents: encaisse - reservedCents,
    social,
  };
}

/** Tunnel waterfall pour un scope donné (Publicodes + taux company). */
export async function getScopedCashflow(
  scope: CashflowScope,
  now: Date = new Date(),
): Promise<ScopedCashflow> {
  const company = await getCompanySettings();
  const period = resolveCashflowPeriod(scope, now);
  const encaisse = await sumEncaisseCents(period.start, period.end);
  const cfeCents = await computeCfeReserveCents({
    cfeAmountCents: company.cfeAmountCents,
    encaisseCents: encaisse,
    periodStart: period.start,
    periodEnd: period.end,
    now,
    businessStartDate: company.businessStartDate,
  });
  return buildCashflowFromEncaisse(encaisse, {
    scope,
    periodLabel: period.label,
    periodKey: period.key,
    now,
    treasuryRateBps: company.treasuryRateBps,
    placementRateBps: company.placementRateBps,
    cfeCents,
  });
}

/** Simulation : répartition sur le CA encaissé d'une facture. */
export async function getInvoiceCashflow(
  invoiceId: string,
  now: Date = new Date(),
): Promise<ScopedCashflow | null> {
  const [company, invoice] = await Promise.all([
    getCompanySettings(),
    prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        payments: { select: { amountCents: true } },
        client: { select: { displayName: true } },
      },
    }),
  ]);
  if (!invoice) return null;

  const paidCents = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
  const label = invoice.number
    ? `Facture ${invoice.number}`
    : `Facture · ${invoice.client.displayName}`;
  const month = monthBounds(now.getFullYear(), now.getMonth() + 1);
  const cfeCents = await computeCfeReserveCents({
    cfeAmountCents: company.cfeAmountCents,
    encaisseCents: paidCents,
    periodStart: month.start,
    periodEnd: month.end,
    now,
    businessStartDate: company.businessStartDate,
  });

  return buildCashflowFromEncaisse(paidCents, {
    scope: "month",
    periodLabel: label,
    periodKey: `invoice:${invoice.id}`,
    now,
    treasuryRateBps: company.treasuryRateBps,
    placementRateBps: company.placementRateBps,
    cfeCents,
  });
}

export type CashflowChartPoint = {
  label: string;
  ca: number;
  urssaf: number;
  charges: number;
  tresorerie: number;
  salaire: number;
  cfe: number;
};

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

type PeriodWindow = { start: Date; end: Date; label: string };

function chartWindows(scope: CashflowScope, now: Date): PeriodWindow[] {
  const windows: PeriodWindow[] = [];

  if (scope === "week") {
    for (let i = 5; i >= 0; i--) {
      const ref = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i * 7);
      const start = startOfIsoWeek(ref);
      const end = endOfIsoWeek(ref);
      windows.push({
        start,
        end,
        label: start.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }),
      });
    }
  } else if (scope === "month") {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    for (let i = 5; i >= 0; i--) {
      const { year, month } = shiftMonth(y, m, -i);
      const b = monthBounds(year, month);
      windows.push({
        start: b.start,
        end: b.end,
        label: b.start.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" }),
      });
    }
  } else if (scope === "quarter") {
    const cur = currentQuarterBounds(now);
    for (let i = 3; i >= 0; i--) {
      let q = cur.quarter - i;
      let year = cur.year;
      while (q < 1) {
        q += 4;
        year -= 1;
      }
      const startMonth = (q - 1) * 3;
      windows.push({
        start: new Date(year, startMonth, 1, 0, 0, 0, 0),
        end: new Date(year, startMonth + 3, 0, 23, 59, 59, 999),
        label: `T${q} ${String(year).slice(2)}`,
      });
    }
  } else {
    const y = now.getFullYear();
    for (let i = 3; i >= 0; i--) {
      const year = y - i;
      windows.push({
        start: new Date(year, 0, 1, 0, 0, 0, 0),
        end: new Date(year, 11, 31, 23, 59, 59, 999),
        label: String(year),
      });
    }
  }

  return windows;
}

/**
 * Série BarChart  -  1 seule query paiements sur la fenêtre + Publicodes en mémoire.
 */
export async function getCashflowChartSeries(
  scope: CashflowScope,
  now: Date = new Date(),
): Promise<CashflowChartPoint[]> {
  const windows = chartWindows(scope, now);
  if (windows.length === 0) return [];

  const rangeStart = windows[0].start;
  const rangeEnd = windows[windows.length - 1].end;

  const [company, payments] = await Promise.all([
    getCompanySettings(),
    prisma.payment.findMany({
      where: {
        paidAt: {
          gte: new Date(Math.min(rangeStart.getTime(), new Date(now.getFullYear(), 0, 1).getTime())),
          lte: rangeEnd,
        },
      },
      select: { amountCents: true, paidAt: true },
    }),
  ]);

  const year = now.getFullYear();
  const activityStart = resolveCfeActivityStart(
    company.businessStartDate,
    year,
    rangeEnd,
  );
  if (!activityStart) {
    return windows.map(({ start, end, label }) => {
      const startMs = start.getTime();
      const endMs = end.getTime();
      const encaisse = payments.reduce((s, p) => {
        const t = p.paidAt.getTime();
        return t >= startMs && t <= endMs ? s + p.amountCents : s;
      }, 0);
      const cf = buildCashflowFromEncaisse(encaisse, {
        scope,
        periodLabel: label,
        periodKey: label,
        now,
        treasuryRateBps: company.treasuryRateBps,
        placementRateBps: company.placementRateBps,
        cfeCents: 0,
      });
      return {
        label,
        ca: cf.totalEncaisseCents / 100,
        urssaf: cf.urssafCents / 100,
        charges: cf.fraisCents / 100,
        tresorerie: cf.tresorerieCents / 100,
        salaire: cf.resteNetCents / 100,
        cfe: 0,
      };
    });
  }

  // Fenêtres mensuelles YTD pour le rattrapage CFE (hors mois creux = 0).
  const cfeMonthWindows: Array<{ start: Date; end: Date; encaisseCents: number }> = [];
  {
    const cursor = new Date(activityStart.getFullYear(), activityStart.getMonth(), 1);
    const last = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1);
    while (cursor.getTime() <= last.getTime()) {
      const b = monthBounds(cursor.getFullYear(), cursor.getMonth() + 1);
      const encaisse = payments.reduce((s, p) => {
        const t = p.paidAt.getTime();
        return t >= b.start.getTime() && t <= b.end.getTime() ? s + p.amountCents : s;
      }, 0);
      cfeMonthWindows.push({ start: b.start, end: b.end, encaisseCents: encaisse });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }
  const monthlyCfe = computeCfeReserveForWindows(
    company.cfeAmountCents,
    cfeMonthWindows,
    year,
    company.businessStartDate,
  );
  const cfeByMonthKey = new Map<string, number>();
  cfeMonthWindows.forEach((w, i) => {
    cfeByMonthKey.set(`${w.start.getFullYear()}-${w.start.getMonth()}`, monthlyCfe[i] ?? 0);
  });

  return windows.map(({ start, end, label }) => {
    const startMs = start.getTime();
    const endMs = end.getTime();
    const encaisse = payments.reduce((s, p) => {
      const t = p.paidAt.getTime();
      return t >= startMs && t <= endMs ? s + p.amountCents : s;
    }, 0);

    let cfeCents = 0;
    if (encaisse > 0) {
      if (scope === "month") {
        cfeCents = cfeByMonthKey.get(`${start.getFullYear()}-${start.getMonth()}`) ?? 0;
      } else if (scope === "year") {
        cfeCents = company.cfeAmountCents;
      } else {
        // Semaine / trimestre : somme des réserves mensuelles touchées par la fenêtre.
        for (const [key, value] of cfeByMonthKey) {
          const [y, m] = key.split("-").map(Number) as [number, number];
          const b = monthBounds(y, m + 1);
          if (b.end.getTime() >= startMs && b.start.getTime() <= endMs) {
            const overlapEncaisse = payments.reduce((s, p) => {
              const t = p.paidAt.getTime();
              return t >= Math.max(startMs, b.start.getTime()) &&
                t <= Math.min(endMs, b.end.getTime())
                ? s + p.amountCents
                : s;
            }, 0);
            if (overlapEncaisse > 0) cfeCents += value;
          }
        }
      }
    }

    const cf = buildCashflowFromEncaisse(encaisse, {
      scope,
      periodLabel: label,
      periodKey: label,
      now,
      treasuryRateBps: company.treasuryRateBps,
      placementRateBps: company.placementRateBps,
      cfeCents,
    });
    return {
      label,
      ca: cf.totalEncaisseCents / 100,
      urssaf: cf.urssafCents / 100,
      charges: cf.fraisCents / 100,
      tresorerie: cf.tresorerieCents / 100,
      salaire: cf.resteNetCents / 100,
      cfe: cf.cfeCents / 100,
    };
  });
}
