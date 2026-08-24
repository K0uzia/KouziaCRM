export type EnvelopeBreakdown = {
  caCents: number;
  urssafCents: number;
  treasuryCents: number;
  salaryNetCents: number;
  urssafRateBps: number;
  treasuryRateBps: number;
  salaryRateBps: number;
};

export const DEFAULT_URSSAF_BPS = 2130;
export const DEFAULT_TREASURY_BPS = 1420;

/** Répartition budgétaire annuelle (legacy / tests). Préférer computeMonthlyCashflow. */
export function splitEnvelopes(
  caCents: number,
  urssafRateBps = DEFAULT_URSSAF_BPS,
  treasuryRateBps = DEFAULT_TREASURY_BPS,
  placementRateBps = 1000,
): EnvelopeBreakdown {
  const safeCa = Math.max(0, Math.round(caCents));
  const urssafCents = Math.round((safeCa * urssafRateBps) / 10_000);
  const treasuryCents = Math.round((safeCa * treasuryRateBps) / 10_000);
  const placementCents = Math.round((safeCa * placementRateBps) / 10_000);
  const salaryNetCents = safeCa - urssafCents - treasuryCents - placementCents;

  return {
    caCents: safeCa,
    urssafCents,
    treasuryCents,
    salaryNetCents,
    urssafRateBps,
    treasuryRateBps,
    salaryRateBps: 10_000 - urssafRateBps - treasuryRateBps - placementRateBps,
  };
}

export function envelopeFillPercent(partCents: number, caCents: number): number {
  if (caCents <= 0) return 0;
  return Math.min(100, Math.round((partCents * 100) / caCents));
}
