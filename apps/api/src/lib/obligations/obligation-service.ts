import {
  ObligationStatus,
  ObligationType,
  UrssafPeriodicity,
  type CompanySettings,
  type Obligation,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
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
  status: ObligationStatus;
  /** Statut d'affichage recalculé (LATE si dueDate passée et PENDING) */
  displayStatus: "LATE" | "PENDING" | "URGENT" | "DONE";
  completedAt: string | null;
  amountCents: number | null;
  notes: string | null;
  label: string;
  daysLate: number | null;
  daysRemaining: number | null;
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
  return endOfDay(
    new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, URSSAF_DEADLINE_DAY),
  );
}

async function sumEncaisseBetween(start: Date, end: Date): Promise<number> {
  const payments = await prisma.payment.findMany({
    where: { paidAt: { gte: start, lte: end } },
    select: { amountCents: true },
  });
  return payments.reduce((s, p) => s + p.amountCents, 0);
}

async function sumEncaisseYear(year: number): Promise<number> {
  return sumEncaisseBetween(
    new Date(year, 0, 1, 0, 0, 0, 0),
    new Date(year, 11, 31, 23, 59, 59, 999),
  );
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

export function computeDisplayStatus(
  obl: Pick<Obligation, "status" | "dueDate" | "completedAt">,
  now = new Date(),
): Pick<ObligationView, "displayStatus" | "daysLate" | "daysRemaining"> {
  if (obl.status === ObligationStatus.DONE || obl.completedAt) {
    return { displayStatus: "DONE", daysLate: null, daysRemaining: null };
  }
  const due = new Date(obl.dueDate);
  if (due < now) {
    return {
      displayStatus: "LATE",
      daysLate: calendarDaysBetween(due, now),
      daysRemaining: null,
    };
  }
  const remaining = calendarDaysBetween(now, due);
  if (remaining <= URGENCY_WINDOW_DAYS) {
    return { displayStatus: "URGENT", daysLate: null, daysRemaining: remaining };
  }
  return { displayStatus: "PENDING", daysLate: null, daysRemaining: remaining };
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

  // 1re déclaration : délai 90 j, mais l'échéance reste toujours un 15
  if (settings.businessStartDate) {
    const grace = addDays(settings.businessStartDate, FIRST_URSSAF_GRACE_DAYS);
    const anyDone = await prisma.obligation.findFirst({
      where: { type: ObligationType.URSSAF_DECLARATION, status: ObligationStatus.DONE },
    });
    if (!anyDone && grace > dueDate) {
      dueDate = endOfDay(
        new Date(grace.getFullYear(), grace.getMonth(), URSSAF_DEADLINE_DAY),
      );
      if (dueDate < grace) {
        dueDate = endOfDay(
          new Date(grace.getFullYear(), grace.getMonth() + 1, URSSAF_DEADLINE_DAY),
        );
      }
      label = `${label} (1re déclaration, délai 90 j)`;
    }
  }

  const encaisse = await sumEncaisseBetween(periodStart, periodEnd);
  const { totalCents } = computeSocialChargesForEncaisse(encaisse);

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
): Promise<Obligation> {
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
    const encaisse = await sumEncaisseBetween(next.start, next.end);
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
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const dueDate = urssafDeadlineForPeriod(end);
  const encaisse = await sumEncaisseBetween(start, end);
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
  const year = now.getFullYear();
  // Avant le 15 décembre de l'année en cours ; après le 15/12 → année suivante
  const periodYear =
    now.getMonth() === 11 && now.getDate() > 15 ? year + 1 : year;
  const dueDate = endOfDay(new Date(periodYear, 11, 15));
  const refYear = periodYear - 1;
  const caRef = await sumEncaisseYear(refYear);
  const exempt = caRef < CFE_EXEMPTION_CA_CENTS;
  const notes = exempt
    ? `Exonéré si CA annuel < 5 000 € (CA ${refYear} : ${(caRef / 100).toFixed(2)} €)`
    : `CA ${refYear} : ${(caRef / 100).toFixed(2)} €`;

  return upsertObligation({
    type: ObligationType.CFE_PAYMENT,
    period: String(periodYear),
    dueDate,
    label: `Paiement CFE ${periodYear}`,
    amountCents: exempt ? 0 : settings.cfeAmountCents,
    notes,
  });
}

async function ensureNextCfe(settings: CompanySettings, completedPeriod: string) {
  const year = Number(completedPeriod) + 1;
  return upsertObligation({
    type: ObligationType.CFE_PAYMENT,
    period: String(year),
    dueDate: endOfDay(new Date(year, 11, 15)),
    label: `Paiement CFE ${year}`,
    amountCents: settings.cfeAmountCents,
    notes: "Exonéré si CA annuel < 5 000 €",
  });
}

async function ensureCfeInitial(settings: CompanySettings) {
  if (!settings.businessStartDate) return null;
  const year = settings.businessStartDate.getFullYear();
  return upsertObligation({
    type: ObligationType.CFE_INITIAL_DECLARATION,
    period: `INITIAL-${year}`,
    dueDate: endOfDay(new Date(year, 11, 31)),
    label: `Déclaration initiale CFE (${year})`,
    amountCents: null,
    notes: "À déposer avant le 31 décembre de l'année de création",
  });
}

async function ensureIncomeTax(settings: CompanySettings, now = new Date()) {
  const month = Math.min(12, Math.max(1, settings.incomeTaxReminderMonth || 4));
  const day = Math.min(28, Math.max(1, settings.incomeTaxReminderDay || 15));
  const declareYear = now.getFullYear();
  const dueThisCycle = endOfDay(new Date(declareYear, month - 1, day));
  const incomeYearForThisCycle = declareYear - 1;

  // Toujours assurer l'obligation du cycle en cours (revenus N-1, rappel en N)
  await upsertObligation({
    type: ObligationType.INCOME_TAX_DECLARATION,
    period: String(incomeYearForThisCycle),
    dueDate: dueThisCycle,
    label: `Déclaration de revenus ${incomeYearForThisCycle}`,
    amountCents: null,
    notes: "Déclaration en ligne (impots.gouv) - plage avril/mai",
  });

  const current = await prisma.obligation.findUnique({
    where: {
      type_period: {
        type: ObligationType.INCOME_TAX_DECLARATION,
        period: String(incomeYearForThisCycle),
      },
    },
  });
  if (current?.status === ObligationStatus.DONE) {
    await ensureNextIncomeTax(settings, String(incomeYearForThisCycle));
  } else {
    // Pas de cycle futur tant que le courant n'est pas confirmé
    await prisma.obligation.deleteMany({
      where: {
        type: ObligationType.INCOME_TAX_DECLARATION,
        status: { not: ObligationStatus.DONE },
        period: { not: String(incomeYearForThisCycle) },
      },
    });
  }
}

async function ensureNextIncomeTax(settings: CompanySettings, completedPeriod: string) {
  const incomeYear = Number(completedPeriod) + 1;
  const month = Math.min(12, Math.max(1, settings.incomeTaxReminderMonth || 4));
  const day = Math.min(28, Math.max(1, settings.incomeTaxReminderDay || 15));
  const declareYear = incomeYear + 1;
  return upsertObligation({
    type: ObligationType.INCOME_TAX_DECLARATION,
    period: String(incomeYear),
    dueDate: endOfDay(new Date(declareYear, month - 1, day)),
    label: `Déclaration de revenus ${incomeYear}`,
    amountCents: null,
    notes: "Déclaration en ligne (impots.gouv) - plage avril/mai",
  });
}

async function ensureActivityQuestionnaire(settings: CompanySettings) {
  if (!settings.businessStartDate) return null;
  const dueDate = addDays(settings.businessStartDate, ACTIVITY_QUESTIONNAIRE_DAYS);
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

/** Aligne les échéances URSSAF ouvertes sur le 15 (correction si ancien deadlineDay). */
async function normalizeOpenUrssafDueDates() {
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
    if (dueDate && o.dueDate.getTime() !== dueDate.getTime()) {
      await prisma.obligation.update({
        where: { id: o.id },
        data: { dueDate },
      });
    }
  }
}

export async function syncObligations(now = new Date()) {
  const settings = await getCompanySettings();
  await ensureUrssafObligation(settings, now);
  await ensureCfePayment(settings, now);
  await ensureCfeInitial(settings);
  await ensureIncomeTax(settings, now);
  await ensureActivityQuestionnaire(settings);
  await normalizeOpenUrssafDueDates();

  // Recalcule LATE vs PENDING pour les non DONE
  const open = await prisma.obligation.findMany({
    where: { status: { not: ObligationStatus.DONE } },
  });
  for (const o of open) {
    const next =
      o.dueDate < now ? ObligationStatus.LATE : ObligationStatus.PENDING;
    if (o.status !== next) {
      await prisma.obligation.update({
        where: { id: o.id },
        data: { status: next },
      });
    }
  }
}

function toView(o: Obligation, links: OfficialLinks, now = new Date()): ObligationView {
  const display = computeDisplayStatus(o, now);
  return {
    id: o.id,
    type: o.type,
    period: o.period,
    dueDate: o.dueDate.toISOString(),
    status: o.status,
    displayStatus: display.displayStatus,
    completedAt: o.completedAt?.toISOString() ?? null,
    amountCents: o.amountCents,
    notes: o.notes,
    label: o.label,
    daysLate: display.daysLate,
    daysRemaining: display.daysRemaining,
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
  const year = new Date().getFullYear();
  const y1 = await sumEncaisseYear(year - 1);
  const y2 = await sumEncaisseYear(year - 2);
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

  const views = all.map((o) => toView(o, links, now));

  const active = views
    .filter((v) => v.displayStatus !== "DONE")
    .sort((a, b) => {
      const rank = (s: string) => (s === "LATE" ? 0 : s === "URGENT" ? 1 : 2);
      const dr = rank(a.displayStatus) - rank(b.displayStatus);
      if (dr !== 0) return dr;
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
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
      pending: active.filter((i) => i.displayStatus === "PENDING").length,
      nextDue: active[0] ?? null,
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
  }>,
) {
  const row = await getOrCreateChecklist();
  return prisma.startupChecklist.update({
    where: { id: row.id },
    data: patch,
  });
}
