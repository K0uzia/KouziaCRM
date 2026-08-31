import type { CompanySettings, Obligation, ObligationType } from "@prisma/client";
import { getBusinessStartLocal } from "@/lib/company/business-start.js";
import { quarterBounds } from "@/lib/finance/urssaf-echeance.js";

export type ObligationWindow = {
  opensAt: Date;
  closesAt: Date;
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/** Clôture campagne impôts : fin mai (N+1), date la plus courante avant départementale. */
export function incomeTaxClosesAt(incomeYear: number): Date {
  return endOfDay(new Date(incomeYear + 1, 4, 31));
}

/**
 * Fenêtre déclarative : ouverture (début alerte) → clôture (dernier délai).
 * `dueDate` en base = clôture pour les types récents ; recalcul si besoin.
 */
export function resolveObligationWindow(
  obl: Pick<Obligation, "type" | "period" | "dueDate">,
  settings: Pick<CompanySettings, "businessStartDate" | "incomeTaxReminderMonth" | "incomeTaxReminderDay">,
): ObligationWindow {
  switch (obl.type as ObligationType) {
    case "URSSAF_DECLARATION": {
      const activityStart = settings.businessStartDate
        ? getBusinessStartLocal(settings.businessStartDate)
        : null;

      const monthly = /^(\d{4})-(\d{2})$/.exec(obl.period);
      if (monthly) {
        const y = Number(monthly[1]);
        const m = Number(monthly[2]);
        const periodEnd = new Date(y, m, 0, 23, 59, 59, 999);
        const standardClose = urssafClosesAt(periodEnd);
        const closesAt = endOfDay(new Date(obl.dueDate));
        let opensAt = startOfDay(new Date(y, m, 1, 0, 0, 0, 0));
        if (activityStart && closesAt.getTime() > standardClose.getTime()) {
          opensAt = activityStart;
        }
        return { opensAt, closesAt };
      }
      const quarterly = /^(\d{4})-Q(\d)$/.exec(obl.period);
      if (quarterly) {
        const y = Number(quarterly[1]);
        const q = Number(quarterly[2]);
        const periodEnd = quarterBounds(y, q).end;
        const standardClose = urssafClosesAt(periodEnd);
        const closesAt = endOfDay(new Date(obl.dueDate));
        let opensAt = startOfDay(new Date(y, q * 3, 1, 0, 0, 0, 0));
        if (activityStart && closesAt.getTime() > standardClose.getTime()) {
          opensAt = activityStart;
        }
        return { opensAt, closesAt };
      }
      break;
    }
    case "CFE_PAYMENT": {
      const year = Number(obl.period) || new Date(obl.dueDate).getFullYear();
      return {
        opensAt: startOfDay(new Date(year, 10, 1)),
        closesAt: endOfDay(new Date(obl.dueDate)),
      };
    }
    case "CFE_INITIAL_DECLARATION": {
      const m = /^INITIAL-(\d{4})$/.exec(obl.period);
      const year = m ? Number(m[1]) : new Date(obl.dueDate).getFullYear();
      const activityStart = settings.businessStartDate
        ? getBusinessStartLocal(settings.businessStartDate)
        : null;
      return {
        opensAt: activityStart ?? startOfDay(new Date(year, 0, 1)),
        closesAt: endOfDay(new Date(year, 11, 31)),
      };
    }
    case "INCOME_TAX_DECLARATION": {
      const incomeYear = Number(obl.period);
      const declareYear = incomeYear + 1;
      return {
        opensAt: startOfDay(new Date(declareYear, 3, 1)),
        closesAt: incomeTaxClosesAt(incomeYear),
      };
    }
    case "ACTIVITY_QUESTIONNAIRE": {
      const start = settings.businessStartDate
        ? getBusinessStartLocal(settings.businessStartDate)!
        : startOfDay(new Date(obl.dueDate));
      return {
        opensAt: start,
        closesAt: endOfDay(new Date(obl.dueDate)),
      };
    }
    default:
      break;
  }

  const closesAt = endOfDay(new Date(obl.dueDate));
  const opensAt = startOfDay(new Date(closesAt));
  opensAt.setDate(opensAt.getDate() - 30);
  return { opensAt, closesAt };
}

/** Échéance URSSAF (15 du mois suivant la fin de période). */
export function urssafClosesAt(periodEnd: Date, deadlineDay = 15): Date {
  const day = Math.min(28, Math.max(1, deadlineDay));
  return endOfDay(new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, day));
}

/** Première ouverture URSSAF pour une période (1er jour du mois suivant la fin). */
export function urssafOpensAt(periodEnd: Date): Date {
  return startOfDay(new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, 1));
}

export function urssafClosesAtForQuarter(year: number, quarter: number, deadlineDay = 15): Date {
  return quarterBounds(year, quarter, deadlineDay).deadline;
}

export function urssafOpensAtForQuarter(year: number, quarter: number): Date {
  const end = quarterBounds(year, quarter).end;
  return urssafOpensAt(end);
}
