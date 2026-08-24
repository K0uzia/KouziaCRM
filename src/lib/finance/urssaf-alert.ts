import { computeMonthlyCashflow } from "@/lib/finance/cashflow";
import {
  calendarDaysBetween,
  monthLabelFr,
  urssafDeadlineForCurrentMonth,
  type MonthRef,
} from "@/lib/finance/dates";
import { formatPercentFromBps } from "@/lib/urssaf";

export type UrssafAlertStatus = "due" | "late";

export type UrssafAlert = {
  /** Toujours visible sur le mois M pour le paiement de M-1 */
  active: true;
  status: UrssafAlertStatus;
  severity: "warning" | "urgent";
  title: string;
  message: string;
  /** 21,30 % du CA encaissé de M-1 */
  amountDueCents: number;
  /** CA encaissé M-1 (transparence) */
  previousEncaisseCents: number;
  periodLabel: string;
  deadlineDay: number;
  deadline: string;
  daysLeft: number;
};

/**
 * Bannière = montant RÉELLEMENT dû ce mois-ci = 21,30 % du CA de M-1.
 * Indépendant du tunnel (réserve sur CA de M).
 */
export function buildUrssafAlert(opts: {
  now?: Date;
  deadlineDay: number;
  previousMonthEncaisseCents: number;
  previousMonth: MonthRef;
  urssafRateBps: number;
}): UrssafAlert {
  const now = opts.now ?? new Date();
  const deadlineDay = Math.min(28, Math.max(1, opts.deadlineDay || 5));
  const deadline = urssafDeadlineForCurrentMonth(now, deadlineDay);
  const daysLeft = calendarDaysBetween(now, deadline);
  const late = daysLeft < 0;
  const status: UrssafAlertStatus = late ? "late" : "due";

  const amountDueCents = computeMonthlyCashflow(
    opts.previousMonthEncaisseCents,
    opts.previousMonth.year,
    opts.previousMonth.month,
    { urssafRateBps: opts.urssafRateBps },
  ).urssafCents;

  const periodLabel = monthLabelFr(opts.previousMonth.year, opts.previousMonth.month);
  const rateLabel = formatPercentFromBps(opts.urssafRateBps);
  const amountLabel = (amountDueCents / 100).toLocaleString("fr-FR", {
    style: "currency",
    currency: "EUR",
  });

  if (late) {
    return {
      active: true,
      status,
      severity: "urgent",
      title: `Retard URSSAF`,
      message: `Le paiement de ${periodLabel} de ${amountLabel} est en retard de ${Math.abs(daysLeft)} jour(s) (basé sur ${rateLabel} du CA encaissé de ${periodLabel}).`,
      amountDueCents,
      previousEncaisseCents: opts.previousMonthEncaisseCents,
      periodLabel,
      deadlineDay,
      deadline: deadline.toISOString(),
      daysLeft,
    };
  }

  return {
    active: true,
    status,
    severity: daysLeft <= 2 ? "urgent" : "warning",
    title: `Échéance URSSAF`,
    message: `Paiement de ${periodLabel} à régler avant le ${deadlineDay}. Montant dû (basé sur ${rateLabel} du CA de ${periodLabel}) : ${amountLabel}.`,
    amountDueCents,
    previousEncaisseCents: opts.previousMonthEncaisseCents,
    periodLabel,
    deadlineDay,
    deadline: deadline.toISOString(),
    daysLeft,
  };
}
