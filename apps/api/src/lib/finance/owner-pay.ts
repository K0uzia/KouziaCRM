import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { getBusinessStartLocal } from "@/lib/company/business-start.js";
import { monthBounds, monthLabelFr } from "@/lib/finance/dates.js";
import { buildCashflowFromEncaisse, computeCfeReserveForWindows } from "@/lib/finance/cashflow-service.js";

export type MonthlyFlow = {
  /** AAAA-MM */
  key: string;
  label: string;
  encaisseCents: number;
  urssafCents: number;
  cfeCents: number;
  tresorerieCents: number;
  resteNetCents: number;
  /** Retraits du mois (virements du compte pro vers le compte perso, saisis à la main). */
  verseCents: number;
  /** Salaire disponible en fin de mois : cumul des restes nets moins cumul des retraits, jamais négatif. */
  salaireDisponibleCents: number;
};

export type OwnerPaySummary = {
  /** Salaire disponible aujourd'hui (cumul depuis le début d'activité). */
  availableCents: number;
  /** Déjà retiré ce mois-ci. */
  paidThisMonthCents: number;
  /** Flux mensuels, du plus ancien au plus récent (12 derniers mois au plus). */
  flows: MonthlyFlow[];
};

type Withdrawal = { date: Date; amountCents: number };

/**
 * Retraits de l'entrepreneur : ses virements du compte pro vers le compte perso, saisis à la main.
 * Les versements Stripe n'en sont pas : ils arrivent sur le compte pro (Stripe n'est qu'un intermédiaire).
 */
export async function listOwnerWithdrawals(): Promise<Withdrawal[]> {
  return prisma.ownerWithdrawal.findMany({ select: { amountCents: true, date: true } });
}

const keyOf = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/**
 * Flux mensuels depuis le début d'activité (à défaut, le 1er encaissement) jusqu'au mois courant.
 * Le reste net d'un mois suit exactement la répartition du tableau de bord (URSSAF, trésorerie,
 * CFE avec rattrapage annuel) ; le salaire disponible cumule les restes nets et déduit les retraits.
 */
export async function computeMonthlyFlows(now: Date = new Date()): Promise<MonthlyFlow[]> {
  const company = await getCompanySettings();
  const [payments, withdrawals, firstPayment] = await Promise.all([
    prisma.payment.findMany({ where: { paidAt: { lte: now } }, select: { amountCents: true, paidAt: true } }),
    listOwnerWithdrawals(),
    prisma.payment.findFirst({ orderBy: { paidAt: "asc" }, select: { paidAt: true } }),
  ]);
  const start = getBusinessStartLocal(company.businessStartDate) ?? firstPayment?.paidAt ?? now;
  const months: Array<{ year: number; month: number }> = [];
  for (
    let y = start.getFullYear(), m = start.getMonth() + 1;
    y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1);
    m === 12 ? ((m = 1), (y += 1)) : (m += 1)
  ) {
    months.push({ year: y, month: m });
  }

  const sumIn = <T>(rows: T[], date: (r: T) => Date, amount: (r: T) => number, s: Date, e: Date) =>
    rows.reduce((acc, r) => {
      const t = date(r).getTime();
      return t >= s.getTime() && t <= e.getTime() ? acc + amount(r) : acc;
    }, 0);

  const windows = months.map(({ year, month }) => {
    const b = monthBounds(year, month);
    return {
      year,
      month,
      start: b.start,
      end: b.end,
      encaisseCents: sumIn(payments, (p) => p.paidAt, (p) => p.amountCents, b.start, b.end),
      verseCents: sumIn(withdrawals, (w) => w.date, (w) => w.amountCents, b.start, b.end),
    };
  });

  // Réserve CFE : rattrapage calculé année par année, comme le graphique du tableau de bord.
  const cfeByKey = new Map<string, number>();
  for (const year of new Set(windows.map((w) => w.year))) {
    const ofYear = windows.filter((w) => w.year === year);
    const reserves = computeCfeReserveForWindows(company.cfeAmountCents, ofYear, year, company.businessStartDate);
    ofYear.forEach((w, i) => cfeByKey.set(keyOf(w.year, w.month), reserves[i] ?? 0));
  }

  let running = 0;
  return windows.map((w) => {
    const key = keyOf(w.year, w.month);
    const cf = buildCashflowFromEncaisse(w.encaisseCents, {
      scope: "month",
      periodLabel: monthLabelFr(w.year, w.month),
      periodKey: key,
      now,
      treasuryRateBps: company.treasuryRateBps,
      placementRateBps: company.placementRateBps,
      cfeCents: cfeByKey.get(key) ?? 0,
    });
    running += cf.resteNetCents - w.verseCents;
    return {
      key,
      label: monthLabelFr(w.year, w.month),
      encaisseCents: cf.totalEncaisseCents,
      urssafCents: cf.urssafCents,
      cfeCents: cf.cfeCents,
      tresorerieCents: cf.tresorerieCents,
      resteNetCents: cf.resteNetCents,
      verseCents: w.verseCents,
      salaireDisponibleCents: Math.max(0, running),
    };
  });
}

/** Salaire disponible cumulé, déjà versé ce mois-ci et flux des 12 derniers mois. */
export async function getOwnerPaySummary(now: Date = new Date()): Promise<OwnerPaySummary> {
  const flows = await computeMonthlyFlows(now);
  const current = flows[flows.length - 1];
  return {
    availableCents: current?.salaireDisponibleCents ?? 0,
    paidThisMonthCents: current?.verseCents ?? 0,
    flows: flows.slice(-12),
  };
}
