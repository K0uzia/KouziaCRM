import { prisma } from "@/lib/prisma";
import { getCompanySettings } from "@/lib/company";
import { computeSocialChargesForEncaisse } from "@/lib/publicodes";
import { monthBounds, monthLabelFr } from "@/lib/finance/dates";

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
  const rows = await prisma.payment.findMany({
    where: { paidAt: { gte: start, lte: end } },
    select: { amountCents: true },
  });
  return rows.reduce((s, p) => s + p.amountCents, 0);
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
  fraisCents: number;
  fraisBps: number;
  placementsCents: number;
  placementsBps: number;
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
  },
): ScopedCashflow {
  const now = meta.now ?? new Date();
  const encaisse = Math.max(0, Math.round(encaisseCents));
  const social = computeSocialChargesForEncaisse(encaisse);
  const fraisCents = Math.round((encaisse * meta.treasuryRateBps) / 10_000);
  const placementsCents = Math.round((encaisse * meta.placementRateBps) / 10_000);
  const urssafCents = social.totalCents;
  const reservedCents = urssafCents + fraisCents + placementsCents;

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
  return buildCashflowFromEncaisse(encaisse, {
    scope,
    periodLabel: period.label,
    periodKey: period.key,
    now,
    treasuryRateBps: company.treasuryRateBps,
    placementRateBps: company.placementRateBps,
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

  return buildCashflowFromEncaisse(paidCents, {
    scope: "month",
    periodLabel: label,
    periodKey: `invoice:${invoice.id}`,
    now,
    treasuryRateBps: company.treasuryRateBps,
    placementRateBps: company.placementRateBps,
  });
}

export type CashflowChartPoint = {
  label: string;
  ca: number;
  urssaf: number;
  charges: number;
  tresorerie: number;
  salaire: number;
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
      where: { paidAt: { gte: rangeStart, lte: rangeEnd } },
      select: { amountCents: true, paidAt: true },
    }),
  ]);

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
    });
    return {
      label,
      ca: cf.totalEncaisseCents / 100,
      urssaf: cf.urssafCents / 100,
      charges: cf.fraisCents / 100,
      tresorerie: cf.placementsCents / 100,
      salaire: cf.resteNetCents / 100,
    };
  });
}
