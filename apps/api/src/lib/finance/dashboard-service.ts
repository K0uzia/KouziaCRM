import { InvoiceStatus, type UrssafPeriodicity } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCompanySettings } from "@/lib/company";
import { computeSocialChargesForEncaisse, computeUrssafDueCents } from "@/lib/publicodes";
import {
  calendarDaysBetween,
  previousQuarter,
  quarterBounds,
  resolveDeclarationPeriod,
  resolveEcheanceStatus,
  resolvePriorDeclarationPeriod,
  resolveUpcomingDeclarationPeriod,
  type EcheanceStatus,
} from "@/lib/finance/urssaf-echeance";
import {
  getCashflowChartSeries,
  getInvoiceCashflow,
  getScopedCashflow,
  isCashflowScope,
  sumEncaisseCents,
  type CashflowChartPoint,
  type CashflowScope,
  type ScopedCashflow,
} from "@/lib/finance/cashflow-service";
import { clipPeriodToActivity } from "@/lib/company/business-start";

export type PriorPeriodStatus = {
  periodKey: string;
  periodLabel: string;
  paid: boolean;
  paidAt: string | null;
};

export type EcheanceCardData = {
  status: EcheanceStatus;
  periodKey: string;
  periodLabel: string;
  deadline: string;
  deadlineDay: number;
  daysLeft: number;
  encaisseCents: number;
  amountDueCents: number;
  breakdown: ReturnType<typeof computeSocialChargesForEncaisse>;
  declarationId: string | null;
  paidAt: string | null;
  periodicity: UrssafPeriodicity;
  /** Prochaine date de déclaration (= paiement AE) */
  nextDeclarationDate: string;
  /** Prochaine date de paiement */
  nextPaymentDate: string;
  nextPeriodLabel: string;
  /** Période de déclaration précédente (M-2 / T-2) */
  priorPeriod: PriorPeriodStatus;
  /** Trimestre civil précédent  -  payé ou non */
  previousQuarter: PriorPeriodStatus;
};

export type DashboardSnapshotV2 = {
  company: { legalName: string; tradeName: string | null };
  scope: CashflowScope;
  invoiceId: string | null;
  echeance: EcheanceCardData;
  cashflow: ScopedCashflow;
  chart: CashflowChartPoint[];
  drafts: number;
  pendingWithBalance: Array<{
    id: string;
    number: string | null;
    displayName: string;
    remaining: number;
  }>;
};

async function loadPeriodPaidStatus(
  periodKey: string,
  label: string,
): Promise<PriorPeriodStatus> {
  const decl = await prisma.urssafDeclaration.findUnique({ where: { periodKey } });
  return {
    periodKey,
    periodLabel: label,
    paid: decl?.status === "PAID",
    paidAt: decl?.paidAt?.toISOString() ?? null,
  };
}

/** Pour un trimestre en mode mensuel : payé si les 3 mois sont PAID. */
async function loadQuarterPaidStatus(
  year: number,
  quarter: number,
): Promise<PriorPeriodStatus> {
  const q = quarterBounds(year, quarter);
  const months = [0, 1, 2].map((i) => {
    const m = (quarter - 1) * 3 + i + 1;
    return `${year}-${String(m).padStart(2, "0")}`;
  });
  const decls = await prisma.urssafDeclaration.findMany({
    where: { periodKey: { in: [...months, q.periodKey] } },
  });
  const byKey = new Map(decls.map((d) => [d.periodKey, d]));
  const quarterly = byKey.get(q.periodKey);
  if (quarterly) {
    return {
      periodKey: q.periodKey,
      periodLabel: q.label,
      paid: quarterly.status === "PAID",
      paidAt: quarterly.paidAt?.toISOString() ?? null,
    };
  }
  const monthDecls = months.map((k) => byKey.get(k));
  const allPaid = monthDecls.every((d) => d?.status === "PAID");
  const lastPaid = monthDecls
    .map((d) => d?.paidAt)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    periodKey: q.periodKey,
    periodLabel: q.label,
    paid: allPaid && monthDecls.every(Boolean),
    paidAt: lastPaid?.toISOString() ?? null,
  };
}

/**
 * Snapshot dashboard.
 * - `scope` → tunnel (si pas de facture) + graphique
 * - `invoiceId` → tunnel simulé sur cette facture
 * - `echeance` → échéance légale (indépendante du scope)
 */
export async function getDashboardSnapshot(
  scopeInput: CashflowScope | string = "month",
  invoiceId: string | null = null,
  now: Date = new Date(),
): Promise<DashboardSnapshotV2> {
  const scope: CashflowScope = isCashflowScope(scopeInput) ? scopeInput : "month";
  const company = await getCompanySettings();
  const periodicity = company.urssafPeriodicity;
  const deadlineDay = company.urssafDeadlineDay;
  const declPeriod = resolveDeclarationPeriod(periodicity, deadlineDay, now);
  const priorDecl = resolvePriorDeclarationPeriod(periodicity, deadlineDay, now);
  const upcoming = resolveUpcomingDeclarationPeriod(periodicity, deadlineDay, now);
  const prevQ = previousQuarter(now);

  const clippedDecl = clipPeriodToActivity(
    declPeriod.periodStart,
    declPeriod.periodEnd,
    company.businessStartDate,
  );

  const [
    periodCashflow,
    invoiceCashflow,
    chart,
    encaisseDuePeriod,
    existingDecl,
    priorPeriod,
    previousQuarterStatus,
    issuedPending,
    drafts,
  ] = await Promise.all([
    getScopedCashflow(scope, now),
    invoiceId ? getInvoiceCashflow(invoiceId, now) : Promise.resolve(null),
    getCashflowChartSeries(scope, now),
    clippedDecl
      ? sumEncaisseCents(clippedDecl.start, clippedDecl.end)
      : Promise.resolve(0),
    prisma.urssafDeclaration.findUnique({ where: { periodKey: declPeriod.periodKey } }),
    loadPeriodPaidStatus(priorDecl.periodKey, priorDecl.label),
    loadQuarterPaidStatus(prevQ.year, prevQ.quarter),
    prisma.invoice.findMany({
      where: { status: InvoiceStatus.ISSUED, documentType: "INVOICE" },
      include: { payments: true, client: { select: { displayName: true } } },
      orderBy: { issueDate: "asc" },
      take: 8,
    }),
    prisma.invoice.count({ where: { status: InvoiceStatus.DRAFT } }),
  ]);

  const breakdownDue = computeSocialChargesForEncaisse(encaisseDuePeriod);
  const amountDueFormal = existingDecl?.amountDueCents ?? breakdownDue.totalCents;
  const isPaid = existingDecl?.status === "PAID";

  const formalStatus = resolveEcheanceStatus({
    amountDueCents: amountDueFormal,
    isPaid,
    deadline: declPeriod.deadline,
    now,
  });

  const settled = formalStatus === "paid" || formalStatus === "clear";
  const nextFocus = settled ? upcoming : declPeriod;

  const echeance: EcheanceCardData = {
    status: formalStatus,
    periodKey: declPeriod.periodKey,
    periodLabel: declPeriod.label,
    deadline: declPeriod.deadline.toISOString(),
    deadlineDay,
    daysLeft: calendarDaysBetween(now, declPeriod.deadline),
    encaisseCents: encaisseDuePeriod,
    amountDueCents: amountDueFormal,
    breakdown: breakdownDue,
    declarationId: existingDecl?.id ?? null,
    paidAt: existingDecl?.paidAt?.toISOString() ?? null,
    periodicity,
    nextDeclarationDate: nextFocus.deadline.toISOString(),
    nextPaymentDate: nextFocus.deadline.toISOString(),
    nextPeriodLabel: nextFocus.label,
    priorPeriod,
    previousQuarter: previousQuarterStatus,
  };

  const cashflow =
    invoiceId && invoiceCashflow ? invoiceCashflow : periodCashflow;

  const pendingWithBalance = issuedPending
    .map((inv) => {
      const paid = inv.payments.reduce((s, p) => s + p.amountCents, 0);
      return {
        id: inv.id,
        number: inv.number,
        displayName: inv.client.displayName,
        remaining: inv.totalCents - paid,
      };
    })
    .filter((inv) => inv.remaining > 0);

  return {
    company: { legalName: company.legalName, tradeName: company.tradeName },
    scope,
    invoiceId: invoiceId && invoiceCashflow ? invoiceId : null,
    echeance,
    cashflow,
    chart,
    drafts,
    pendingWithBalance,
  };
}

export async function markUrssafPaid(opts: {
  periodKey?: string;
  paymentRef?: string;
  now?: Date;
}) {
  const company = await getCompanySettings();
  const now = opts.now ?? new Date();
  const declPeriod = resolveDeclarationPeriod(
    company.urssafPeriodicity,
    company.urssafDeadlineDay,
    now,
  );
  const periodKey = opts.periodKey ?? declPeriod.periodKey;
  const encaisse = await sumEncaisseCents(declPeriod.periodStart, declPeriod.periodEnd);
  const amountDueCents = computeUrssafDueCents(encaisse);

  return prisma.urssafDeclaration.upsert({
    where: { periodKey },
    create: {
      periodKey,
      periodicity: company.urssafPeriodicity,
      periodStart: declPeriod.periodStart,
      periodEnd: declPeriod.periodEnd,
      deadline: declPeriod.deadline,
      encaisseCents: encaisse,
      amountDueCents,
      status: "PAID",
      paidAt: now,
      paymentRef: opts.paymentRef ?? null,
    },
    update: {
      status: "PAID",
      paidAt: now,
      paymentRef: opts.paymentRef ?? null,
      amountDueCents,
      encaisseCents: encaisse,
    },
  });
}

export type { CashflowScope, CashflowChartPoint, ScopedCashflow };
