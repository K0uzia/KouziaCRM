import { EmailOutboxStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

// Durées de conservation (RGPD, documentées dans le README, section « Conservation des données ») :
// purge par le worker, chaque heure. Les pièces comptables et les clients qui en ont ne sont jamais touchés.
const DAY = 86_400_000;
export const RETENTION = {
  /** Prospect sans suite : 3 ans après le dernier contact (référentiel CNIL, gestion commerciale). */
  prospectMs: 3 * 365 * DAY,
  /** Invitation expirée ou utilisée. */
  invitationMs: 30 * DAY,
  /** Contenu d'un e-mail envoyé (la ligne reste : date, état, erreur). */
  outboxPayloadMs: 30 * DAY,
  /** Journal des e-mails envoyés à un client (suivi /suivi et fiche client). */
  emailEventMs: 365 * DAY,
} as const;

/**
 * Prospect sans suite : aucun document (même brouillon), aucun abonnement, projet, avis ni témoignage, et aucune activité
 * depuis 3 ans (fiche, e-mail envoyé, fil de messagerie). Les fils de la boîte IMAP restent (miroir) et
 * perdent seulement le lien vers la fiche.
 */
async function purgeStaleProspects(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION.prospectMs);
  const stale = await prisma.client.findMany({
    where: {
      updatedAt: { lt: cutoff },
      invoices: { none: {} },
      subscriptions: { none: {} },
      projects: { none: {} },
      // Un avis ou témoignage lié prouve la relation client (L111-7-2) : la fiche reste.
      siteReviews: { none: {} },
      testimonials: { none: {} },
      emailEvents: { none: { sentAt: { gte: cutoff } } },
      emailThreads: { none: { lastMessageAt: { gte: cutoff } } },
    },
    select: { id: true },
    take: 200,
  });
  if (stale.length === 0) return 0;
  const { count } = await prisma.client.deleteMany({ where: { id: { in: stale.map((c) => c.id) }, invoices: { none: {} }, subscriptions: { none: {} } } });
  return count;
}

export async function purgeRetention(now: Date = new Date()) {
  const before = (ms: number) => new Date(now.getTime() - ms);
  const invitations = await prisma.onboardingInvitation.deleteMany({
    where: {
      OR: [{ usedAt: { lt: before(RETENTION.invitationMs) } }, { usedAt: null, expiresAt: { lt: before(RETENTION.invitationMs) } }],
    },
  });
  const outbox = await prisma.emailOutbox.updateMany({
    where: {
      status: EmailOutboxStatus.SENT,
      sentAt: { lt: before(RETENTION.outboxPayloadMs) },
      OR: [{ payload: { not: "" } }, { payloadEncrypted: { not: null } }],
    },
    data: { payload: "", payloadEncrypted: null },
  });
  const emailEvents = await prisma.clientEmailEvent.deleteMany({ where: { sentAt: { lt: before(RETENTION.emailEventMs) } } });
  // Sessions admin expirées (7 jours au plus) ou inactives depuis 24 h.
  const sessions = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { lastSeenAt: { lt: new Date(now.getTime() - DAY) } }] },
  });
  const prospects = await purgeStaleProspects(now);
  return { invitations: invitations.count, outbox: outbox.count, emailEvents: emailEvents.count, sessions: sessions.count, prospects };
}
