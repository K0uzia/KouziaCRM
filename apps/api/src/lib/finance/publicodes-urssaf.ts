/** @deprecated Utiliser `@/lib/publicodes` */
export {
  computeSocialChargesForEncaisse as estimateLegalCotisationsFromMonthly,
  computeUrssafDueCents,
  getPublicodesEngine,
} from "@/lib/publicodes";

import { computeSocialChargesForEncaisse } from "@/lib/publicodes";

/** Compat ancienne API (CA annuel → total annuel). */
export function estimateLegalCotisationsCents(caAnnuelEuros: number) {
  const monthly = computeSocialChargesForEncaisse(Math.round((caAnnuelEuros * 100) / 12));
  return {
    cotisationsCents: monthly.totalCents * 12,
    monthlyEuros: monthly.totalCents / 100,
    rule: "dirigeant . auto-entrepreneur . cotisations et contributions",
    caAnnuelEuros,
  };
}
