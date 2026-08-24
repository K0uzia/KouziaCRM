import type { UrssafPeriodicity } from "@prisma/client";
import {
  calendarDaysBetween,
  currentMonth,
  monthBounds,
  monthLabelFr,
  previousMonth,
  urssafDeadlineForCurrentMonth,
  type MonthRef,
} from "@/lib/finance/dates";

export type DeclarationPeriod = {
  periodKey: string;
  periodicity: UrssafPeriodicity;
  period: MonthRef | { year: number; quarter: number; start: Date; end: Date };
  periodStart: Date;
  periodEnd: Date;
  deadline: Date;
  label: string;
};

export type QuarterRef = {
  year: number;
  quarter: number;
  start: Date;
  end: Date;
  periodKey: string;
  label: string;
  /** Échéance déclaration+paiement (deadlineDay du mois suivant la fin du T) */
  deadline: Date;
};

/** Trimestre civil contenant `ref` (1–4). */
export function currentQuarter(ref: Date = new Date()): QuarterRef {
  const year = ref.getFullYear();
  const quarter = Math.floor(ref.getMonth() / 3) + 1;
  return quarterBounds(year, quarter);
}

/** Trimestre civil précédent. */
export function previousQuarter(ref: Date = new Date()): QuarterRef {
  const cur = currentQuarter(ref);
  if (cur.quarter === 1) return quarterBounds(cur.year - 1, 4);
  return quarterBounds(cur.year, cur.quarter - 1);
}

export function quarterBounds(year: number, quarter: number, deadlineDay = 5): QuarterRef {
  const q = Math.min(4, Math.max(1, quarter));
  const startMonth = (q - 1) * 3;
  const start = new Date(year, startMonth, 1, 0, 0, 0, 0);
  const end = new Date(year, startMonth + 3, 0, 23, 59, 59, 999);
  const day = Math.min(28, Math.max(1, deadlineDay));
  const deadline = new Date(end.getFullYear(), end.getMonth() + 1, day, 23, 59, 59, 999);
  return {
    year,
    quarter: q,
    start,
    end,
    periodKey: `${year}-Q${q}`,
    label: `T${q} ${year}`,
    deadline,
  };
}

/**
 * Période à déclarer / payer en cours (M-1 mensuel, T-1 trimestriel)
 * + date limite dans le mois/trimestre d'échéance.
 */
export function resolveDeclarationPeriod(
  periodicity: UrssafPeriodicity,
  deadlineDay: number,
  now: Date = new Date(),
): DeclarationPeriod {
  const day = Math.min(28, Math.max(1, deadlineDay || 5));

  if (periodicity === "QUARTERLY") {
    const q = previousQuarter(now);
    const withDay = quarterBounds(q.year, q.quarter, day);
    return {
      periodKey: withDay.periodKey,
      periodicity,
      period: withDay,
      periodStart: withDay.start,
      periodEnd: withDay.end,
      deadline: withDay.deadline,
      label: withDay.label,
    };
  }

  const prev = previousMonth(now);
  const deadline = urssafDeadlineForCurrentMonth(now, day);
  return {
    periodKey: `${prev.year}-${String(prev.month).padStart(2, "0")}`,
    periodicity,
    period: prev,
    periodStart: prev.start,
    periodEnd: prev.end,
    deadline,
    label: monthLabelFr(prev.year, prev.month),
  };
}

/**
 * Prochaine échéance de déclaration & paiement après la période courante due.
 * Mensuel : CA du mois en cours → deadlineDay du mois suivant.
 * Trimestriel : trimestre civil en cours → deadline après sa fin.
 */
export function resolveUpcomingDeclarationPeriod(
  periodicity: UrssafPeriodicity,
  deadlineDay: number,
  now: Date = new Date(),
): DeclarationPeriod {
  const day = Math.min(28, Math.max(1, deadlineDay || 5));

  if (periodicity === "QUARTERLY") {
    const q = currentQuarter(now);
    const withDay = quarterBounds(q.year, q.quarter, day);
    return {
      periodKey: withDay.periodKey,
      periodicity,
      period: withDay,
      periodStart: withDay.start,
      periodEnd: withDay.end,
      deadline: withDay.deadline,
      label: withDay.label,
    };
  }

  const cur = currentMonth(now);
  const deadline = new Date(cur.year, cur.month, day, 23, 59, 59, 999);
  return {
    periodKey: `${cur.year}-${String(cur.month).padStart(2, "0")}`,
    periodicity,
    period: cur,
    periodStart: cur.start,
    periodEnd: cur.end,
    deadline,
    label: monthLabelFr(cur.year, cur.month),
  };
}

/** Période de déclaration immédiatement avant celle due maintenant (M-2 / T-2). */
export function resolvePriorDeclarationPeriod(
  periodicity: UrssafPeriodicity,
  deadlineDay: number,
  now: Date = new Date(),
): DeclarationPeriod {
  const current = resolveDeclarationPeriod(periodicity, deadlineDay, now);
  const pivot = new Date(current.periodStart.getTime() - 1);
  return resolveDeclarationPeriod(periodicity, deadlineDay, pivot);
}

export type EcheanceStatus = "paid" | "due" | "late" | "clear";

export function resolveEcheanceStatus(opts: {
  amountDueCents: number;
  isPaid: boolean;
  deadline: Date;
  now?: Date;
}): EcheanceStatus {
  if (opts.isPaid || opts.amountDueCents <= 0) return opts.isPaid ? "paid" : "clear";
  const now = opts.now ?? new Date();
  const days = calendarDaysBetween(now, opts.deadline);
  if (days < 0) return "late";
  return "due";
}

export { currentMonth, previousMonth, monthBounds, monthLabelFr, calendarDaysBetween };
