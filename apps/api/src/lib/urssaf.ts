/** basis points → ratio (2110 → 0.211) */
export function bpsToRate(bps: number): number {
  return bps / 10_000;
}

export function estimateUrssafCents(encaisséCents: number, urssafRateBps: number): number {
  return Math.round((encaisséCents * urssafRateBps) / 10_000);
}

export function formatPercentFromBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(".", ",")}\u00a0%`;
}
