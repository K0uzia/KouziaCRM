import {
  ObligationStatus,
  ObligationType,
  UrssafPeriodicity,
  type CompanySettings,
  type Obligation,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings, invalidateCompanySettingsCache } from "@/lib/company.js";
import { monthLabelFr, calendarDaysBetween } from "@/lib/finance/dates.js";
import {
  previousMonth,
  previousQuarter,
  quarterBounds,
  currentQuarter,
  currentMonth,
} from "@/lib/finance/urssaf-echeance.js";
import { computeSocialChargesForEncaisse } from "@/lib/publicodes.js";
import {
  officialLinkForObligationType,
  resolveOfficialLinks,
  type OfficialLinks,
} from "@/lib/obligations/links.js";
import {
  incomeTaxClosesAt,
  resolveObligationWindow,
  urssafClosesAt,
} from "@/lib/obligations/window.js";
import {
  cfeAmountForPaymentYear,
  clipPeriodToActivity,
  getBusinessStartLocal,
  hasActivityStarted,
  monthsActiveInCalendarYear,
  toBusinessStartLocal,
} from "@/lib/company/business-start.js";

const CFE_EXEMPTION_CA_CENTS = 500_000; // 5 000 €
const BANK_DEDICATED_THRESHOLD_CENTS = 1_000_000; // 10 000 €
const FIRST_URSSAF_GRACE_DAYS = 90;
const ACTIVITY_QUESTIONNAIRE_DAYS = 30;
const URGENCY_WINDOW_DAYS = 7;
/** Micro-entreprise : déclaration URSSAF avant le 15 du mois suivant */
const URSSAF_DEADLINE_DAY = 15;

export type ObligationView = {
  id: string;
  type: ObligationType;
  period: string;
  dueDate: string;
  windowStart: string;
  windowEnd: string;
  status: ObligationStatus;
  /** UPCOMING avant ouverture, OPEN pendant la fenêtre, URGENT (<7 j), LATE après clôture */
  displayStatus: "UPCOMING" | "OPEN" | "LATE" | "URGENT" | "DONE";
  completedAt: string | null;
  amountCents: number | null;
  notes: string | null;
  label: string;
  daysLate: number | null;
  daysRemaining: number | null;
  daysUntilOpen: number | null;
  officialUrl: string;
  confirmLabel: string;
  attachmentName: string | null;
  hasAttachment: boolean;
};

export type ObligationsDashboard = {
  items: ObligationView[];
  history: ObligationView[];
  summary: {
    late: number;
    urgent: number;
    open: number;
    upcoming: number;
    pending: number;
    nextDue: ObligationView | null;
  };
  alerts: Array<{ kind: string; message: string }>;
  links: OfficialLinks;
  checklist: Awaited<ReturnType<typeof getOrCreateChecklist>>;
  bankThreshold: {
    yearsOver: number[];
    alert: boolean;
  };
};

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return endOfDay(out);
}

function urssafDeadlineForPeriod(periodEnd: Date): Date {
  return urssafClosesAt(periodEnd, URSSAF_DEADLINE_DAY);
}

/** 1re déclaration URSSAF : délai 90 j après début d'activité, échéance au 15 suivant. */
async function applyFirstUrssafGrace(
  settings: CompanySettings,
  periodStart: Date,
  baseDueDate: Date,
  label: string,
): Promise<{ dueDate: Date; label: string }> {
  if (!settings.businessStartDate) return { dueDate: baseDueDate, label };

  const activityStart = getBusinessStartLocal(settings.businessStartDate)!;
  if (periodStart.getTime() > activityStart.getTime()) {
    const stripped = label.replace(" (1re déclaration, délai 90 j)", "");
    return { dueDate: baseDueDate, label: stripped };
  }

  const grace = addDays(activityStart, FIRST_URSSAF_GRACE_DAYS);
  const anyDone = await prisma.obligation.findFirst({
    where: { type: ObligationType.URSSAF_DECLARATION, status: ObligationStatus.DONE },
  });
  if (anyDone || grace.getTime() <= baseDueDate.getTime()) {
    const stripped = label.replace(" (1re déclaration, délai 90 j)", "");
    return { dueDate: baseDueDate, label: stripped };
  }

  let dueDate = endOfDay(
    new Date(grace.getFullYear(), grace.getMonth(), URSSAF_DEADLINE_DAY),
  );
  if (dueDate.getTime() < grace.getTime()) {
    dueDate = endOfDay(
      new Date(grace.getFullYear(), grace.getMonth() + 1, URSSAF_DEADLINE_DAY),
    );
  }

  if (label.includes("1re déclaration")) {
    return { dueDate, label };
  }
  const nextLabel = label.includes("1re période")
    ? `${label.replace(" (1re période)", "")} (1re déclaration, délai 90 j)`
    : `${label} (1re déclaration, délai 90 j)`;
  return { dueDate, label: nextLabel };
}

export function computeDisplayStatus(
  obl: Pick<Obligation, "status" | "dueDate" | "completedAt">,
  window: { opensAt: Date; closesAt: Date },
  now = new Date(),
): Pick<ObligationView, "displayStatus" | "daysLate" | "daysRemaining" | "daysUntilOpen"> {
  if (obl.status === ObligationStatus.DONE || obl.completedAt) {
    return {
      displayStatus: "DONE",
      daysLate: null,
      daysRemaining: null,
      daysUntilOpen: null,
    };
  }

  const { opensAt, closesAt } = window;

  if (now.getTime() < opensAt.getTime()) {
    return {
      displayStatus: "UPCOMING",
      daysLate: null,
      daysRemaining: null,
      daysUntilOpen: calendarDaysBetween(now, opensAt),
    };
  }

  if (now.getTime() > closesAt.getTime()) {
    return {
      displayStatus: "LATE",
      daysLate: calendarDaysBetween(closesAt, now),
      daysRemaining: null,
      daysUntilOpen: null,
    };
  }

  const remaining = calendarDaysBetween(now, closesAt);
  if (remaining <= URGENCY_WINDOW_DAYS) {
    return {
      displayStatus: "URGENT",
      daysLate: null,
      daysRemaining: remaining,
      daysUntilOpen: null,
    };
  }

  return {
    displayStatus: "OPEN",
    daysLate: null,
    daysRemaining: remaining,
    daysUntilOpen: null,
  };
}

async function sumEncaisseBetween(start: Date, end: Date): Promise<number> {
  const payments = await prisma.payment.findMany({
    where: { paidAt: { gte: start, lte: end } },
    select: { amountCents: true },
  });
  return payments.reduce((s, p) => s + p.amountCents, 0);
}

async function sumEncaisseYear(year: number, businessStartDate?: Date | null): Promise<number> {
  const start = new Date(year, 0, 1, 0, 0, 0, 0);
  const end = new Date(year, 11, 31, 23, 59, 59, 999);
  const clipped = clipPeriodToActivity(start, end, businessStartDate);
  if (!clipped) return 0;
  return sumEncaisseBetween(clipped.start, clipped.end);
}

/** Supprime les échéances antérieures au début d'activité. */
async function purgeObligationsBeforeActivity(settings: CompanySettings) {
  const start = getBusinessStartLocal(settings.businessStartDate);
  if (!start) return;

  const open = await prisma.obligation.findMany({
    where: { status: { not: ObligationStatus.DONE } },
  });

  for (const o of open) {
    let periodEnd: Date | null = null;
    const monthly = /^(\d{4})-(\d{2})$/.exec(o.period);
    const quarterly = /^(\d{4})-Q(\d)$/.exec(o.period);
    const cfeYear = /^(\d{4})$/.exec(o.period);

    if (monthly) {
      const y = Number(monthly[1]);
      const m = Number(monthly[2]);
      periodEnd = new Date(y, m, 0, 23, 59, 59, 999);
    } else if (quarterly) {
      periodEnd = quarterBounds(Number(quarterly[1]), Number(quarterly[2])).end;
    } else if (cfeYear && o.type === ObligationType.CFE_PAYMENT) {
      periodEnd = new Date(Number(cfeYear[1]), 11, 31, 23, 59, 59, 999);
    }

    if (periodEnd && periodEnd.getTime() < start.getTime()) {
      await prisma.obligation.delete({ where: { id: o.id } });
    }
  }
}

function confirmLabelFor(type: ObligationType): string {
  switch (type) {
    case ObligationType.CFE_PAYMENT:
      return "J'ai payé";
    case ObligationType.URSSAF_DECLARATION:
      return "J'ai déclaré / payé";
    default:
      return "J'ai déclaré";
  }
}

async function upsertObligation(data: {
  type: ObligationType;
  period: string;
  dueDate: Date;
  label: string;
  amountCents?: number | null;
  notes?: string | null;
}): Promise<Obligation> {
  const existing = await prisma.obligation.findUnique({
    where: { type_period: { type: data.type, period: data.period } },
  });
  if (existing) {
    if (existing.status === ObligationStatus.DONE) return existing;
    return prisma.obligation.update({
      where: { id: existing.id },
      data: {
        dueDate: data.dueDate,
        label: data.label,
        amountCents: data.amountCents ?? existing.amountCents,
        notes: data.notes ?? existing.notes,
        status:
          data.dueDate < new Date() && existing.status !== ObligationStatus.DONE
            ? ObligationStatus.LATE
            : ObligationStatus.PENDING,
      },
    });
  }
  return prisma.obligation.create({
    data: {
      type: data.type,
      period: data.period,
      dueDate: data.dueDate,
      label: data.label,
      amountCents: data.amountCents ?? null,
      notes: data.notes ?? null,
      status: data.dueDate < new Date() ? ObligationStatus.LATE : ObligationStatus.PENDING,
    },
  });
}

/** Première échéance URSSAF après création (délai 90 j) ou période courante due. */
async function ensureUrssafObligation(settings: CompanySettings, now = new Date()) {
  if (!settings.businessStartDate) return null;

  const periodicity = settings.urssafPeriodicity;

  let periodKey: string;
  let periodStart: Date;
  let periodEnd: Date;
  let label: string;
  let dueDate: Date;

  if (periodicity === UrssafPeriodicity.QUARTERLY) {
    const q = previousQuarter(now);
    const withDay = quarterBounds(q.year, q.quarter, URSSAF_DEADLINE_DAY);
    periodKey = withDay.periodKey;
    periodStart = withDay.start;
    periodEnd = withDay.end;
    label = `Déclaration URSSAF : ${withDay.label}`;
    dueDate = withDay.deadline;
  } else {
    const prev = previousMonth(now);
    periodKey = `${prev.year}-${String(prev.month).padStart(2, "0")}`;
    periodStart = prev.start;
    periodEnd = prev.end;
    label = `Déclaration URSSAF : ${monthLabelFr(prev.year, prev.month)}`;
    dueDate = urssafDeadlineForPeriod(periodEnd);
  }

  const clipped = clipPeriodToActivity(periodStart, periodEnd, settings.businessStartDate);
  if (!clipped) {
    const activityStart = getBusinessStartLocal(settings.businessStartDate)!;
    if (now.getTime() < activityStart.getTime()) {
      if (periodicity === UrssafPeriodicity.QUARTERLY) {
        const q = Math.floor(activityStart.getMonth() / 3) + 1;
        const first = quarterBounds(activityStart.getFullYear(), q, URSSAF_DEADLINE_DAY);
        periodKey = first.periodKey;
        periodStart = activityStart.getTime() > first.start.getTime() ? activityStart : first.start;
        periodEnd = first.end;
        label = `Déclaration URSSAF : ${first.label} (1re période)`;
        dueDate = first.deadline;
      } else {
        const y = activityStart.getFullYear();
        const m = activityStart.getMonth() + 1;
        periodKey = `${y}-${String(m).padStart(2, "0")}`;
        periodStart = activityStart;
        periodEnd = new Date(y, m, 0, 23, 59, 59, 999);
        label = `Déclaration URSSAF : ${monthLabelFr(y, m)} (1re période)`;
        dueDate = urssafDeadlineForPeriod(periodEnd);
      }
    } else {
      return null;
    }
  } else {
    periodStart = clipped.start;
    periodEnd = clipped.end;
  }

  ({ dueDate, label } = await applyFirstUrssafGrace(settings, periodStart, dueDate, label));

  const encaisse = await sumEncaisseBetween(periodStart, periodEnd);
  const { totalCents } = computeSocialChargesForEncaisse(encaisse);

  await prisma.obligation.deleteMany({
    where: {
      type: ObligationType.URSSAF_DECLARATION,
      status: { not: ObligationStatus.DONE },
      period: { not: periodKey },
    },
  });

  return upsertObligation({
    type: ObligationType.URSSAF_DECLARATION,
    period: periodKey,
    dueDate,
    label,
    amountCents: totalCents,
    notes: encaisse === 0 ? "CA encaissé de la période : 0 €" : null,
  });
}

async function ensureNextUrssafAfter(
  settings: CompanySettings,
  completedPeriod: string,
): Promise<Obligation | null> {
  if (!settings.businessStartDate) return null;

  if (settings.urssafPeriodicity === UrssafPeriodicity.QUARTERLY) {
    const m = /^(\d{4})-Q(\d)$/.exec(completedPeriod);
    let year = m ? Number(m[1]) : new Date().getFullYear();
    let quarter = m ? Number(m[2]) : currentQuarter().quarter;
    quarter += 1;
    if (quarter > 4) {
      quarter = 1;
      year += 1;
    }
    const next = quarterBounds(year, quarter, URSSAF_DEADLINE_DAY);
    const clipped = clipPeriodToActivity(next.start, next.end, settings.businessStartDate);
    if (!clipped) return null;
    const encaisse = await sumEncaisseBetween(clipped.start, clipped.end);
    const { totalCents } = computeSocialChargesForEncaisse(encaisse);
    return upsertObligation({
      type: ObligationType.URSSAF_DECLARATION,
      period: next.periodKey,
      dueDate: next.deadline,
      label: `Déclaration URSSAF : ${next.label}`,
      amountCents: totalCents,
    });
  }

  const m = /^(\d{4})-(\d{2})$/.exec(completedPeriod);
  let year = m ? Number(m[1]) : new Date().getFullYear();
  let month = m ? Number(m[2]) : currentMonth().month;
  month += 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  const clipped = clipPeriodToActivity(start, end, settings.businessStartDate);
  if (!clipped) return null;
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const dueDate = urssafDeadlineForPeriod(clipped.end);
  const encaisse = await sumEncaisseBetween(clipped.start, clipped.end);
  const { totalCents } = computeSocialChargesForEncaisse(encaisse);
  return upsertObligation({
    type: ObligationType.URSSAF_DECLARATION,
    period,
    dueDate,
    label: `Déclaration URSSAF : ${monthLabelFr(year, month)}`,
    amountCents: totalCents,
  });
}

async function ensureCfePayment(settings: CompanySettings, now = new Date()) {
  if (!settings.businessStartDate) return null;
  if (!hasActivityStarted(settings.businessStartDate, now)) return null;

  const start = getBusinessStartLocal(settings.businessStartDate)!;
  const year = now.getFullYear();
  // Avant le 15 décembre de l'année en cours ; après le 15/12 → année suivante
  const periodYear =
    now.getMonth() === 11 && now.getDate() > 15 ? year + 1 : year;

  if (periodYear < start.getFullYear()) return null;

  const dueDate = endOfDay(new Date(periodYear, 11, 15));
  const refYear = periodYear - 1;
  const caRef = await sumEncaisseYear(refYear, settings.businessStartDate);
  const exempt = caRef < CFE_EXEMPTION_CA_CENTS;
  const prorataAmount = cfeAmountForPaymentYear(
    settings.cfeAmountCents,
    settings.businessStartDate,
    periodYear,
  );
  if (prorataAmount === null) return null;

  const prorataMonths =
    periodYear === start.getFullYear()
      ? monthsActiveInCalendarYear(start, periodYear)
      : 12;
  const notes = exempt
    ? `Exonéré si CA annuel < 5 000 € (CA ${refYear} : ${(caRef / 100).toFixed(2)} €)`
    : prorataMonths < 12
      ? `CFE prorata ${prorataMonths}/12 (année de création) · CA ${refYear} : ${(caRef / 100).toFixed(2)} €`
      : `CA ${refYear} : ${(caRef / 100).toFixed(2)} €`;

  return upsertObligation({
    type: ObligationType.CFE_PAYMENT,
    period: String(periodYear),
    dueDate,
    label: `Paiement CFE ${periodYear}`,
    amountCents: exempt ? 0 : prorataAmount,
    notes,
  });
}

async function ensureNextCfe(settings: CompanySettings, completedPeriod: string) {
  if (!settings.businessStartDate) return null;

  const year = Number(completedPeriod) + 1;
  const prorataAmount = cfeAmountForPaymentYear(
    settings.cfeAmountCents,
    settings.businessStartDate,
    year,
  );
  if (prorataAmount === null) return null;

  const start = getBusinessStartLocal(settings.businessStartDate)!;
  const refYear = year - 1;
  const caRef = await sumEncaisseYear(refYear, settings.businessStartDate);
  const exempt = caRef < CFE_EXEMPTION_CA_CENTS;
  const prorataMonths =
    year === start.getFullYear() ? monthsActiveInCalendarYear(start, year) : 12;
  const notes = exempt
    ? `Exonéré si CA annuel < 5 000 € (CA ${refYear} : ${(caRef / 100).toFixed(2)} €)`
    : prorataMonths < 12
      ? `CFE prorata ${prorataMonths}/12 (année de création) · CA ${refYear} : ${(caRef / 100).toFixed(2)} €`
      : `CA ${refYear} : ${(caRef / 100).toFixed(2)} €`;

  return upsertObligation({
    type: ObligationType.CFE_PAYMENT,
    period: String(year),
    dueDate: endOfDay(new Date(year, 11, 15)),
    label: `Paiement CFE ${year}`,
    amountCents: exempt ? 0 : prorataAmount,
    notes,
  });
}

async function ensureCfeInitial(settings: CompanySettings) {
  if (!settings.businessStartDate) return null;

  const checklist = await getOrCreateChecklist();
  const start = getBusinessStartLocal(settings.businessStartDate)!;
  const year = start.getFullYear();
  const period = `INITIAL-${year}`;

  const existingDone = await prisma.obligation.findFirst({
    where: { type: ObligationType.CFE_INITIAL_DECLARATION, status: ObligationStatus.DONE },
  });
  if (existingDone || checklist.cfeInitialDeclaration) {
    await prisma.obligation.deleteMany({
      where: {
        type: ObligationType.CFE_INITIAL_DECLARATION,
        status: { not: ObligationStatus.DONE },
      },
    });
    if (checklist.cfeInitialDeclaration && !existingDone) {
      await prisma.obligation.create({
        data: {
          type: ObligationType.CFE_INITIAL_DECLARATION,
          period,
          dueDate: endOfDay(new Date(year, 11, 31)),
          label: `Déclaration initiale CFE (${year})`,
          amountCents: null,
          notes: "Confirmée via la checklist",
          status: ObligationStatus.DONE,
          completedAt: new Date(),
        },
      });
    }
    return null;
  }

  await prisma.obligation.deleteMany({
    where: {
      type: ObligationType.CFE_INITIAL_DECLARATION,
      period: { not: period },
    },
  });

  return upsertObligation({
    type: ObligationType.CFE_INITIAL_DECLARATION,
    period,
    dueDate: endOfDay(new Date(year, 11, 31)),
    label: `Déclaration initiale CFE (${year})`,
    amountCents: null,
    notes: "À déposer avant le 31 décembre de l'année de création",
  });
}

function incomeTaxDueDate(
  incomeYear: number,
  _settings: Pick<CompanySettings, "incomeTaxReminderMonth" | "incomeTaxReminderDay">,
): Date {
  return incomeTaxClosesAt(incomeYear);
}

function incomeTaxNotes(incomeYear: number): string {
  return `Ouverture 1 avril ${incomeYear + 1}, clôture 31 mai ${incomeYear + 1} (revenus ${incomeYear})`;
}

async function ensureIncomeTax(settings: CompanySettings, now = new Date()) {
  if (!settings.businessStartDate) return null;

  const activityStart = getBusinessStartLocal(settings.businessStartDate)!;
  const declareYear = now.getFullYear();
  let incomeYear = declareYear - 1;

  const lastDeclaredRaw = settings.lastIncomeTaxDeclaredYear;
  const lastDeclared =
    lastDeclaredRaw != null && lastDeclaredRaw >= activityStart.getFullYear()
      ? lastDeclaredRaw
      : null;

  if (incomeYear < activityStart.getFullYear()) {
    incomeYear = activityStart.getFullYear();
  }

  if (lastDeclared != null && incomeYear <= lastDeclared) {
    await prisma.obligation.deleteMany({
      where: {
        type: ObligationType.INCOME_TAX_DECLARATION,
        status: { not: ObligationStatus.DONE },
        period: { lte: String(lastDeclared) },
      },
    });
    await ensureNextIncomeTax(settings, String(lastDeclared));
    return null;
  }

  const dueDate = incomeTaxDueDate(incomeYear, settings);

  await upsertObligation({
    type: ObligationType.INCOME_TAX_DECLARATION,
    period: String(incomeYear),
    dueDate,
    label: `Déclaration de revenus ${incomeYear}`,
    amountCents: null,
    notes: incomeTaxNotes(incomeYear),
  });

  const current = await prisma.obligation.findUnique({
    where: {
      type_period: {
        type: ObligationType.INCOME_TAX_DECLARATION,
        period: String(incomeYear),
      },
    },
  });
  if (current?.status === ObligationStatus.DONE) {
    await ensureNextIncomeTax(settings, String(incomeYear));
  } else {
    // Pas de cycle futur tant que le courant n'est pas confirmé
    await prisma.obligation.deleteMany({
      where: {
        type: ObligationType.INCOME_TAX_DECLARATION,
        status: { not: ObligationStatus.DONE },
        period: { not: String(incomeYear) },
      },
    });
  }
}

async function ensureNextIncomeTax(settings: CompanySettings, completedPeriod: string) {
  if (!settings.businessStartDate) return null;

  const incomeYear = Number(completedPeriod) + 1;
  const activityStart = getBusinessStartLocal(settings.businessStartDate)!;
  if (incomeYear < activityStart.getFullYear()) return null;

  return upsertObligation({
    type: ObligationType.INCOME_TAX_DECLARATION,
    period: String(incomeYear),
    dueDate: incomeTaxClosesAt(incomeYear),
    label: `Déclaration de revenus ${incomeYear}`,
    amountCents: null,
    notes: incomeTaxNotes(incomeYear),
  });
}

async function ensureActivityQuestionnaire(settings: CompanySettings) {
  if (!settings.businessStartDate) return null;
  const dueDate = addDays(toBusinessStartLocal(settings.businessStartDate), ACTIVITY_QUESTIONNAIRE_DAYS);
  return upsertObligation({
    type: ObligationType.ACTIVITY_QUESTIONNAIRE,
    period: "ONCE",
    dueDate,
    label: "Questionnaire relatif à l'activité professionnelle",
    amountCents: null,
    notes: "À renvoyer sous 30 jours après le début d'activité",
  });
}

export async function getOrCreateChecklist() {
  const existing = await prisma.startupChecklist.findFirst();
  if (existing) return existing;
  return prisma.startupChecklist.create({ data: {} });
}

/** Aligne les échéances URSSAF ouvertes (15 du mois + délai 90 j 1re déclaration). */
async function normalizeOpenUrssafDueDates(settings: CompanySettings) {
  const open = await prisma.obligation.findMany({
    where: {
      type: ObligationType.URSSAF_DECLARATION,
      status: { not: ObligationStatus.DONE },
    },
  });
  for (const o of open) {
    const monthly = /^(\d{4})-(\d{2})$/.exec(o.period);
    const quarterly = /^(\d{4})-Q(\d)$/.exec(o.period);
    let dueDate: Date | null = null;
    if (monthly) {
      const year = Number(monthly[1]);
      const month = Number(monthly[2]);
      dueDate = urssafDeadlineForPeriod(
        new Date(year, month, 0, 23, 59, 59, 999),
      );
    } else if (quarterly) {
      dueDate = quarterBounds(
        Number(quarterly[1]),
        Number(quarterly[2]),
        URSSAF_DEADLINE_DAY,
      ).deadline;
    }
    if (!dueDate) continue;

    let periodStart: Date | null = null;
    if (monthly) {
      const year = Number(monthly[1]);
      const month = Number(monthly[2]);
      periodStart = new Date(year, month - 1, 1, 0, 0, 0, 0);
    } else if (quarterly) {
      periodStart = quarterBounds(Number(quarterly[1]), Number(quarterly[2])).start;
    }
    if (!periodStart) continue;

    const { dueDate: adjusted, label } = await applyFirstUrssafGrace(
      settings,
      periodStart,
      dueDate,
      o.label,
    );
    const patch: { dueDate?: Date; label?: string } = {};
    if (o.dueDate.getTime() !== adjusted.getTime()) patch.dueDate = adjusted;
    if (o.label !== label) patch.label = label;
    if (Object.keys(patch).length > 0) {
      await prisma.obligation.update({
        where: { id: o.id },
        data: patch,
      });
    }
  }
}

export async function syncObligations(now = new Date()) {
  const settings = await getCompanySettings();
  await purgeObligationsBeforeActivity(settings);
  await ensureUrssafObligation(settings, now);
  await ensureCfePayment(settings, now);
  await ensureCfeInitial(settings);
  await ensureIncomeTax(settings, now);
  await ensureActivityQuestionnaire(settings);
  await normalizeOpenUrssafDueDates(settings);

  // Recalcule LATE vs PENDING pour les non DONE
  const open = await prisma.obligation.findMany({
    where: { status: { not: ObligationStatus.DONE } },
  });
  for (const o of open) {
    const window = resolveObligationWindow(o, settings);
    const display = computeDisplayStatus(o, window, now);
    const next =
      display.displayStatus === "LATE" ? ObligationStatus.LATE : ObligationStatus.PENDING;
    const patch: { status: ObligationStatus; dueDate?: Date } = { status: next };
    if (o.dueDate.getTime() !== window.closesAt.getTime()) {
      patch.dueDate = window.closesAt;
    }
    if (o.status !== next || patch.dueDate) {
      await prisma.obligation.update({
        where: { id: o.id },
        data: patch,
      });
    }
  }
}

function toView(
  o: Obligation,
  links: OfficialLinks,
  settings: CompanySettings,
  now = new Date(),
): ObligationView {
  const window = resolveObligationWindow(o, settings);
  const display = computeDisplayStatus(o, window, now);
  return {
    id: o.id,
    type: o.type,
    period: o.period,
    dueDate: window.closesAt.toISOString(),
    windowStart: window.opensAt.toISOString(),
    windowEnd: window.closesAt.toISOString(),
    status: o.status,
    displayStatus: display.displayStatus,
    completedAt: o.completedAt?.toISOString() ?? null,
    amountCents: o.amountCents,
    notes: o.notes,
    label: o.label,
    daysLate: display.daysLate,
    daysRemaining: display.daysRemaining,
    daysUntilOpen: display.daysUntilOpen,
    officialUrl: officialLinkForObligationType(o.type, links),
    confirmLabel: confirmLabelFor(o.type),
    attachmentName: o.attachmentName,
    hasAttachment: Boolean(o.attachmentPath),
  };
}

async function detectBankThresholdAlert(): Promise<{
  yearsOver: number[];
  alert: boolean;
}> {
  const settings = await getCompanySettings();
  const year = new Date().getFullYear();
  const y1 = await sumEncaisseYear(year - 1, settings.businessStartDate);
  const y2 = await sumEncaisseYear(year - 2, settings.businessStartDate);
  const yearsOver: number[] = [];
  if (y2 >= BANK_DEDICATED_THRESHOLD_CENTS) yearsOver.push(year - 2);
  if (y1 >= BANK_DEDICATED_THRESHOLD_CENTS) yearsOver.push(year - 1);
  return {
    yearsOver,
    alert: yearsOver.length >= 2,
  };
}

export async function listObligationsDashboard(now = new Date()): Promise<ObligationsDashboard> {
  await syncObligations(now);
  const settings = await getCompanySettings();
  const links = resolveOfficialLinks(settings.officialLinks);
  const checklist = await getOrCreateChecklist();
  const bankThreshold = await detectBankThresholdAlert();

  const all = await prisma.obligation.findMany({
    orderBy: [{ dueDate: "asc" }],
  });

  const views = all.map((o) => toView(o, links, settings, now));

  const active = views
    .filter((v) => v.displayStatus !== "DONE")
    .sort((a, b) => {
      const rank = (s: string) =>
        s === "LATE" ? 0 : s === "URGENT" ? 1 : s === "OPEN" ? 2 : 3;
      const dr = rank(a.displayStatus) - rank(b.displayStatus);
      if (dr !== 0) return dr;
      return new Date(a.windowEnd).getTime() - new Date(b.windowEnd).getTime();
    });

  const history = views
    .filter((v) => v.displayStatus === "DONE")
    .sort(
      (a, b) =>
        new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime(),
    );

  const alerts: Array<{ kind: string; message: string }> = [];
  if (settings.b2cActivity) {
    alerts.push({
      kind: "mediation",
      message:
        "Vous facturez des particuliers : vérifiez l'obligation de médiation de la consommation (amende jusqu'à 3 000 €).",
    });
  }
  if (bankThreshold.alert && !checklist.dedicatedBankAccount) {
    alerts.push({
      kind: "bank",
      message: `CA encaissé > 10 000 € sur deux années consécutives (${bankThreshold.yearsOver.join(", ")}) : un compte bancaire dédié pro est obligatoire.`,
    });
  }

  return {
    items: active,
    history,
    summary: {
      late: active.filter((i) => i.displayStatus === "LATE").length,
      urgent: active.filter((i) => i.displayStatus === "URGENT").length,
      open: active.filter((i) => i.displayStatus === "OPEN").length,
      upcoming: active.filter((i) => i.displayStatus === "UPCOMING").length,
      pending: active.filter((i) => i.displayStatus === "OPEN" || i.displayStatus === "URGENT")
        .length,
      nextDue: active.find((i) => i.displayStatus !== "UPCOMING") ?? active[0] ?? null,
    },
    alerts,
    links,
    checklist,
    bankThreshold,
  };
}

export async function confirmObligation(id: string, now = new Date()) {
  const settings = await getCompanySettings();
  const obl = await prisma.obligation.findUniqueOrThrow({ where: { id } });
  if (obl.status === ObligationStatus.DONE) {
    return { obligation: obl, next: null as Obligation | null };
  }

  const updated = await prisma.obligation.update({
    where: { id },
    data: {
      status: ObligationStatus.DONE,
      completedAt: now,
    },
  });

  // Sync checklist flags when relevant
  const checklist = await getOrCreateChecklist();
  if (obl.type === ObligationType.ACTIVITY_QUESTIONNAIRE) {
    await prisma.startupChecklist.update({
      where: { id: checklist.id },
      data: { activityQuestionnaire: true },
    });
  }
  if (obl.type === ObligationType.CFE_INITIAL_DECLARATION) {
    await prisma.startupChecklist.update({
      where: { id: checklist.id },
      data: { cfeInitialDeclaration: true },
    });
  }
  if (obl.type === ObligationType.INCOME_TAX_DECLARATION) {
    const incomeYear = Number(obl.period);
    if (Number.isFinite(incomeYear)) {
      await prisma.companySettings.update({
        where: { id: settings.id },
        data: {
          lastIncomeTaxDeclaredYear: Math.max(
            settings.lastIncomeTaxDeclaredYear ?? 0,
            incomeYear,
          ),
        },
      });
      invalidateCompanySettingsCache();
    }
  }

  let next: Obligation | null = null;
  switch (obl.type) {
    case ObligationType.URSSAF_DECLARATION:
      next = await ensureNextUrssafAfter(settings, obl.period);
      break;
    case ObligationType.CFE_PAYMENT:
      next = await ensureNextCfe(settings, obl.period);
      break;
    case ObligationType.INCOME_TAX_DECLARATION:
      next = await ensureNextIncomeTax(settings, obl.period);
      break;
    default:
      next = null;
  }

  // Also mirror URSSAF into UrssafDeclaration for legacy banque page
  if (obl.type === ObligationType.URSSAF_DECLARATION) {
    await prisma.urssafDeclaration.upsert({
      where: { periodKey: obl.period },
      create: {
        periodKey: obl.period,
        periodicity: settings.urssafPeriodicity,
        periodStart: now,
        periodEnd: now,
        deadline: obl.dueDate,
        encaisseCents: 0,
        amountDueCents: obl.amountCents ?? 0,
        status: "PAID",
        paidAt: now,
      },
      update: {
        status: "PAID",
        paidAt: now,
        amountDueCents: obl.amountCents ?? undefined,
      },
    });
  }

  return { obligation: updated, next };
}

export async function patchObligationAmount(id: string, amountCents: number) {
  return prisma.obligation.update({
    where: { id },
    data: { amountCents },
  });
}

export async function updateChecklist(
  patch: Partial<{
    urssafAccount: boolean;
    impotsProAccount: boolean;
    activityQuestionnaire: boolean;
    cfeInitialDeclaration: boolean;
    rcpInsurance: boolean;
    mediationChecked: boolean;
    dedicatedBankAccount: boolean;
    lastIncomeTaxDeclaredYear: number;
  }>,
) {
  const row = await getOrCreateChecklist();
  const { lastIncomeTaxDeclaredYear, ...checklistPatch } = patch;

  if (lastIncomeTaxDeclaredYear !== undefined) {
    const settings = await getCompanySettings();
    await prisma.companySettings.update({
      where: { id: settings.id },
      data: { lastIncomeTaxDeclaredYear },
    });
    invalidateCompanySettingsCache();
    await syncObligations();
  }

  if (Object.keys(checklistPatch).length === 0) {
    return row;
  }

  const updated = await prisma.startupChecklist.update({
    where: { id: row.id },
    data: checklistPatch,
  });

  if (checklistPatch.cfeInitialDeclaration === true) {
    await syncObligations();
  }

  return updated;
}
