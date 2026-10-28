/**
 * Durée d'engagement d'un abonnement (offre tout compris, décision du 19/10/2026). Pendant l'engagement, le client ne
 * résilie pas lui-même : il demande la résiliation, l'admin la traite. Elle prend effet à la fin de l'engagement ou
 * d'une année reconduite, avec un mois de préavis (cancellableTermOf, décision du 23/10/2026).
 */
import { parisParts, parisWallTime } from "@/lib/format-fr.js";

export const COMMITMENT_MONTHS = [12, 24, 36] as const;
export type CommitmentMonths = (typeof COMMITMENT_MONTHS)[number];

export function isCommitmentMonths(value: unknown): value is CommitmentMonths {
  return (COMMITMENT_MONTHS as readonly unknown[]).includes(value);
}

/**
 * Fin de l'engagement : départ du contrat + durée, même jour du mois (31 janvier + 1 mois : 28 ou 29 février), même
 * heure. Calendrier de Paris, quel que soit le fuseau du serveur (audit du 25/10/2026).
 */
export function commitmentEndOf(start: Date, months: number): Date {
  const p = parisParts(start);
  const index = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return parisWallTime(year, month, Math.min(p.day, last), p.hour, p.minute, start.getTime() % 60_000);
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
export function cancellableTermOf(
  commitmentEndsAt: Date,
  now = new Date(),
  notice?: RenewalNoticeState,
): { termEndsAt: Date; cancelDeadline: Date; freeTermination?: true } {
  const free = notice ? freeTerminationOf(commitmentEndsAt, now, notice) : null;
  if (free) return { termEndsAt: free, cancelDeadline: now, freeTermination: true };
  for (let years = 0; ; years += 1) {
    const termEndsAt = commitmentEndOf(commitmentEndsAt, years * 12);
    const cancelDeadline = commitmentEndOf(termEndsAt, -CANCEL_NOTICE_MONTHS);
    const lastDay = new Date(cancelDeadline);
    lastDay.setDate(lastDay.getDate() + 1);
    if (lastDay.getTime() > now.getTime()) return { termEndsAt, cancelDeadline };
  }
}

/** Clients protégés par l'article L215-1 du Code de la consommation : non-professionnels (association, particulier). */
export const isNonProfessionalClient = (type: string | null | undefined) => type === "ASSOCIATION" || type === "B2C";

/** Information de reconduction d'un abonnement, pour l'article L215-1 (renewalReminderSentFor, renewalReminderSentAt). */
export type RenewalNoticeState = {
  nonProfessional: boolean;
  renewalReminderSentFor: Date | null;
  renewalReminderSentAt: Date | null;
  /** Fin de la période déjà facturée (prochaine échéance de l'abonnement). */
  paidPeriodEndsAt: Date;
};

/** État de l'information de reconduction d'un abonnement chargé (champs absents : rien d'envoyé). */
export function renewalNoticeOf(
  sub: { renewalReminderSentFor?: Date | null; renewalReminderSentAt?: Date | null; nextInvoiceAt: Date },
  clientType: string | null | undefined,
): RenewalNoticeState {
  return {
    nonProfessional: isNonProfessionalClient(clientType),
    renewalReminderSentFor: sub.renewalReminderSentFor ?? null,
    renewalReminderSentAt: sub.renewalReminderSentAt ?? null,
    paidPeriodEndsAt: sub.nextInvoiceAt,
  };
}

/**
 * Article L215-1 al. 2 (CGV, « Information avant la reconduction ») : un client non professionnel qui n'a pas reçu
 * l'information de reconduction, au plus tôt trois mois et au plus tard un mois avant la date limite (un mois avant la
 * reconduction), peut mettre fin à l'abonnement à tout moment à compter de la reconduction, sans rien devoir au-delà de
 * la période déjà payée (décision du 28/10/2026). Renvoie la date d'effet d'une telle fin, ou null (engagement en
 * cours, client professionnel, information faite à temps). Avis ancien sans date d'envoi : tenu pour fait.
 */
export function freeTerminationOf(commitmentEndsAt: Date, now: Date, notice: RenewalNoticeState): Date | null {
  if (!notice.nonProfessional) return null;
  let renewal: Date | null = null;
  for (let years = 0; ; years += 1) {
    const end = commitmentEndOf(commitmentEndsAt, years * 12);
    if (end.getTime() > now.getTime()) break;
    renewal = end;
  }
  if (!renewal) return null;
  const deadline = commitmentEndOf(renewal, -CANCEL_NOTICE_MONTHS);
  const sentAt = notice.renewalReminderSentAt;
  const informed =
    notice.renewalReminderSentFor?.getTime() === renewal.getTime() &&
    (!sentAt || (sentAt >= commitmentEndOf(deadline, -3) && sentAt <= commitmentEndOf(deadline, -1)));
  if (informed) return null;
  return notice.paidPeriodEndsAt.getTime() > now.getTime() ? notice.paidPeriodEndsAt : now;
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
