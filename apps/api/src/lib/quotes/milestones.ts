import { MilestoneStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

export type MilestoneTemplate = {
  position: number;
  label: string;
  percentBps: number;
  triggerText: string;
};

/** Échéancier défaut 30 / 40 / 30 */
export const DEFAULT_MILESTONE_TEMPLATE: MilestoneTemplate[] = [
  {
    position: 1,
    label: "Acompte",
    percentBps: 3000,
    triggerText: "À la signature du devis",
  },
  {
    position: 2,
    label: "Échéance intermédiaire",
    percentBps: 4000,
    triggerText: "À mi-parcours du projet",
  },
  {
    position: 3,
    label: "Solde",
    percentBps: 3000,
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

export async function ensureQuoteMilestones(
  quoteId: string,
  totalCents: number,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const existing = await db.paymentMilestone.count({ where: { quoteId } });
  if (existing > 0) return db.paymentMilestone.findMany({
    where: { quoteId },
    orderBy: { position: "asc" },
  });

  const amounts = computeMilestoneAmounts(totalCents);
  await db.paymentMilestone.createMany({
    data: amounts.map((m) => ({
      quoteId,
      position: m.position,
      label: m.label,
      percentBps: m.percentBps,
      amountCents: m.amountCents,
      triggerText: m.triggerText,
      status: MilestoneStatus.PENDING,
    })),
  });

  return db.paymentMilestone.findMany({
    where: { quoteId },
    orderBy: { position: "asc" },
  });
}
