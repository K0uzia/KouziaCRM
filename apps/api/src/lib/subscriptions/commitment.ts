/**
 * Durée d'engagement d'un abonnement (offre tout compris, décision du 19/10/2026). Pendant l'engagement, le client ne
 * résilie pas lui-même : il demande la résiliation, l'admin la traite. Elle prend effet à la fin de l'engagement ou
 * d'une année reconduite, avec un mois de préavis (cancellableTermOf, décision du 23/10/2026).
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

/** Préavis de résiliation d'un abonnement engagé (décision du 23/10/2026) : un mois avant la fin de la période. */
export const CANCEL_NOTICE_MONTHS = 1;

/**
 * Abonnement engagé, quel que soit son rythme de paiement (décision du 23/10/2026) : jamais résiliable avant la fin
 * de l'engagement, puis reconduit tacitement par périodes d'un an. Une résiliation prend effet à la fin de
 * l'engagement ou d'une année reconduite (termEndsAt), demandée au plus tard un mois avant (cancelDeadline, inclus).
 * Date limite passée : c'est la période suivante qui est visée.
 */
export function cancellableTermOf(commitmentEndsAt: Date, now = new Date()): { termEndsAt: Date; cancelDeadline: Date } {
  for (let years = 0; ; years += 1) {
    const termEndsAt = commitmentEndOf(commitmentEndsAt, years * 12);
    const cancelDeadline = commitmentEndOf(termEndsAt, -CANCEL_NOTICE_MONTHS);
    const lastDay = new Date(cancelDeadline);
    lastDay.setDate(lastDay.getDate() + 1);
    if (lastDay.getTime() > now.getTime()) return { termEndsAt, cancelDeadline };
  }
}

/** Fin de la période en cours d'un abonnement engagé : fin de l'engagement, puis de chaque année reconduite. */
export function currentTermEndOf(commitmentEndsAt: Date, now = new Date()): Date {
  for (let years = 0; ; years += 1) {
    const end = commitmentEndOf(commitmentEndsAt, years * 12);
    if (end.getTime() > now.getTime()) return end;
  }
}

/** « 36 mois », « 12 mois » : libellé de la durée. */
export const commitmentLabel = (months: number) => `${months} mois`;
