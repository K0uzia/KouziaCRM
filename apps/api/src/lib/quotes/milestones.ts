import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

export type MilestoneTemplate = {
  position: number;
  label: string;
  percentBps: number;
  triggerText: string;
};

/** Échéancier défaut : acompte à la validation, solde à la livraison. */
export const DEFAULT_MILESTONE_TEMPLATE: MilestoneTemplate[] = [
  {
    position: 1,
    label: "Acompte",
    percentBps: 3000,
    triggerText: "À la validation du devis",
  },
  {
    position: 2,
    label: "Solde",
    percentBps: 7000,
    triggerText: "À la livraison / fin de mission",
  },
];

/** Répartit totalCents selon les % ; l'écart d'arrondi va sur le dernier jalon */
export function computeMilestoneAmounts(
  totalCents: number,
  template: MilestoneTemplate[] = DEFAULT_MILESTONE_TEMPLATE,
): Array<MilestoneTemplate & { amountCents: number }> {
  const sorted = [...template].sort((a, b) => a.position - b.position);
  let allocated = 0;
  return sorted.map((m, index) => {
    const isLast = index === sorted.length - 1;
    const amountCents = isLast
      ? totalCents - allocated
      : Math.round((totalCents * m.percentBps) / 10000);
    if (!isLast) allocated += amountCents;
    return { ...m, amountCents };
  });
}

/**
 * Devis à propositions sans proposition retenue : aucun échéancier (audit du 27/10/2026). Créé sur l'offre nulle de
 * l'émission, il aurait suivi les réglages par défaut et la proposition la moins chère, puis été exigé du client.
 */
export async function awaitsProposalChoice(quoteId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<boolean> {
  const quote = await db.invoice.findUnique({ where: { id: quoteId }, select: { selectedOptionId: true, _count: { select: { options: true } } } });
  return Boolean(quote && quote._count.options > 0 && !quote.selectedOptionId);
}
