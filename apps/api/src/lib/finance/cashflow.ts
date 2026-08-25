import {
  DEFAULT_TREASURY_BPS,
  DEFAULT_URSSAF_BPS,
  envelopeFillPercent,
} from "@/lib/finance/envelopes";

export const DEFAULT_PLACEMENT_BPS = 1000;

export type CashflowBreakdown = {
  year: number;
  month: number; // 1-12
  totalEncaisseCents: number;
  urssafCents: number;
  fraisCents: number;
  placementsCents: number;
  reservedCents: number;
  resteNetCents: number;
  rates: {
    urssafBps: number;
    fraisBps: number;
    placementsBps: number;
  };
};

export type CashflowRates = {
  urssafRateBps?: number;
  treasuryRateBps?: number;
  placementRateBps?: number;
};

/**
 * Tunnel de cashflow mensuel  -  une seule source : CA encaissé.
 * resteNet = entrées − (URSSAF + frais + placements)
 */
export function computeMonthlyCashflow(
  totalEncaisseCents: number,
  year: number,
  month: number,
  rates: CashflowRates = {},
): CashflowBreakdown {
  const urssafBps = rates.urssafRateBps ?? DEFAULT_URSSAF_BPS;
  const fraisBps = rates.treasuryRateBps ?? DEFAULT_TREASURY_BPS;
  const placementsBps = rates.placementRateBps ?? DEFAULT_PLACEMENT_BPS;

  const totalEncaisse = Math.max(0, Math.round(totalEncaisseCents));
  const urssafCents = Math.round((totalEncaisse * urssafBps) / 10_000);
  const fraisCents = Math.round((totalEncaisse * fraisBps) / 10_000);
  const placementsCents = Math.round((totalEncaisse * placementsBps) / 10_000);
  const reservedCents = urssafCents + fraisCents + placementsCents;
  const resteNetCents = totalEncaisse - reservedCents;

  return {
    year,
    month,
    totalEncaisseCents: totalEncaisse,
    urssafCents,
    fraisCents,
    placementsCents,
    reservedCents,
    resteNetCents,
    rates: {
      urssafBps,
      fraisBps,
      placementsBps,
    },
  };
}

export { envelopeFillPercent };

// Réexport dates pour compat  -  source de vérité : dates.ts
export {
  currentMonth as currentCalendarMonth,
  previousMonth as previousCalendarMonth,
} from "@/lib/finance/dates";
