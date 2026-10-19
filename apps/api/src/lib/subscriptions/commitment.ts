/**
 * Durée d'engagement d'un abonnement (offre tout compris, décision du 19/10/2026). Pendant l'engagement, le client ne
 * résilie pas lui-même : il demande la résiliation, l'admin la traite (annuités restantes dues, selon le contrat).
 * Après : résiliation libre à l'échéance, reconduction annuelle refusable comme un abonnement annuel ordinaire.
 */
export const COMMITMENT_MONTHS = [12, 24, 36] as const;
export type CommitmentMonths = (typeof COMMITMENT_MONTHS)[number];

export function isCommitmentMonths(value: unknown): value is CommitmentMonths {
  return (COMMITMENT_MONTHS as readonly unknown[]).includes(value);
}

/** Fin de l'engagement : départ du contrat + durée, même jour du mois (31 janvier + 1 mois : 28 ou 29 février). */
export function commitmentEndOf(start: Date, months: number): Date {
  const end = new Date(start);
  const day = end.getDate();
  end.setDate(1);
  end.setMonth(end.getMonth() + months);
  const last = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
  end.setDate(Math.min(day, last));
  return end;
}

/** Abonnement encore engagé à cette date. */
export function isUnderCommitment(sub: { commitmentEndsAt: Date | null }, now = new Date()): boolean {
  return Boolean(sub.commitmentEndsAt && sub.commitmentEndsAt.getTime() > now.getTime());
}

/** « 36 mois », « 12 mois » : libellé de la durée. */
export const commitmentLabel = (months: number) => `${months} mois`;
