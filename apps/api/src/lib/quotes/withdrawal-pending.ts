import { prisma } from "@/lib/prisma.js";
import { startAfterWithdrawal } from "@/lib/quotes/withdrawal.js";

/**
 * Devis signé par un particulier sans demande d'exécution anticipée : rien ne démarre avant
 * le lendemain du délai de rétractation (CGV art. 9.4). Date de démarrage au plus tôt tant
 * qu'elle n'est pas passée, sinon null.
 */
export async function pendingStartOf(quoteId: string | null, now = new Date()): Promise<Date | null> {
  if (!quoteId) return null;
  const proof = await prisma.quoteAcceptanceAudit.findFirst({
    where: { quoteId },
    orderBy: { createdAt: "desc" },
    select: { consumer: true, expressExecution: true, withdrawalEndsAt: true },
  });
  if (!proof?.consumer || proof.expressExecution || !proof.withdrawalEndsAt) return null;
  const start = startAfterWithdrawal(proof.withdrawalEndsAt);
  return start > now ? start : null;
}

/** Devis acceptés encore dans le délai de rétractation, sans demande d'exécution anticipée. */
export async function listPendingStarts(now = new Date()) {
  const proofs = await prisma.quoteAcceptanceAudit.findMany({
    where: { consumer: true, expressExecution: false, withdrawalEndsAt: { gte: now } },
    orderBy: { withdrawalEndsAt: "asc" },
    select: {
      withdrawalEndsAt: true,
      quote: { select: { id: true, number: true, quoteStatus: true, client: { select: { displayName: true } } } },
    },
  });
  return proofs
    .filter((p) => p.quote.quoteStatus === "ACCEPTED" && p.withdrawalEndsAt)
    .map((p) => ({
      quoteId: p.quote.id,
      number: p.quote.number,
      displayName: p.quote.client.displayName,
      startsNotBefore: startAfterWithdrawal(p.withdrawalEndsAt!),
    }));
}
