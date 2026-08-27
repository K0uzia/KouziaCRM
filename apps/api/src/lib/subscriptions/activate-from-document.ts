import { prisma } from "@/lib/prisma";
import {
  createSubscription,
  SubscriptionError,
} from "@/lib/subscriptions/subscription-service";

export type ActivateSubscriptionsResult = {
  created: number;
  subscriptionIds: string[];
};

/**
 * Crée les Subscription manquants pour les lignes `isSubscription` d'un document.
 * Idempotent via InvoiceLine.subscriptionId.
 * skipCurrentPeriod : la 1ʳᵉ échéance est déjà dans le total du document.
 */
export async function activateSubscriptionsFromDocument(
  documentId: string,
): Promise<ActivateSubscriptionsResult> {
  const doc = await prisma.invoice.findUnique({
    where: { id: documentId },
    include: {
      lines: { orderBy: { position: "asc" } },
    },
  });
  if (!doc) {
    throw new SubscriptionError("Document introuvable");
  }

  const subscriptionIds: string[] = [];
  let created = 0;

  for (const line of doc.lines) {
    if (!line.isSubscription) continue;
    if (line.subscriptionId) {
      subscriptionIds.push(line.subscriptionId);
      continue;
    }
    if (!line.serviceId || !line.billingDay) {
      throw new SubscriptionError(
        `Ligne « ${line.description} » : prestation et jour de facturation requis`,
      );
    }

    const sub = await createSubscription({
      clientId: doc.clientId,
      serviceId: line.serviceId,
      label: line.description,
      amountCents: line.unitPriceCents,
      billingDay: line.billingDay,
      startDate: new Date(),
      skipCurrentPeriod: true,
    });

    await prisma.invoiceLine.update({
      where: { id: line.id },
      data: { subscriptionId: sub.id },
    });

    subscriptionIds.push(sub.id);
    created += 1;
  }

  return { created, subscriptionIds };
}
