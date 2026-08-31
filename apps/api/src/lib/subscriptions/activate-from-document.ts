import { SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  createSubscription,
  updateSubscription,
  SubscriptionError,
  type Db,
} from "@/lib/subscriptions/subscription-service";

export type ActivateSubscriptionsResult = {
  created: number;
  updated: number;
  subscriptionIds: string[];
};

/**
 * Crée ou met à jour l'abonnement des lignes `isSubscription` d'un document.
 * Règle : un seul abonnement actif par client. Si un abonnement actif existe
 * déjà, on le met à jour (montant/libellé/jour) au lieu d'en créer un second.
 * Idempotent via InvoiceLine.subscriptionId.
 * skipCurrentPeriod : la 1ʳᵉ échéance est déjà dans le total du document.
 */
export async function activateSubscriptionsFromDocument(
  documentId: string,
  db: Db = prisma,
): Promise<ActivateSubscriptionsResult> {
  const doc = await db.invoice.findUnique({
    where: { id: documentId },
    include: {
      lines: { orderBy: { position: "asc" } },
    },
  });
  if (!doc) {
    throw new SubscriptionError("Document introuvable");
  }

  const subscriptionLines = doc.lines.filter((l) => l.isSubscription);
  if (subscriptionLines.length > 1) {
    throw new SubscriptionError(
      "Un seul abonnement actif par client : une seule ligne abonnement autorisée par document",
    );
  }

  const subscriptionIds: string[] = [];
  let created = 0;
  let updated = 0;

  for (const line of subscriptionLines) {
    if (line.subscriptionId) {
      subscriptionIds.push(line.subscriptionId);
      continue;
    }
    if (!line.serviceId || !line.billingDay) {
      throw new SubscriptionError(
        `Ligne « ${line.description} » : prestation et jour de facturation requis`,
      );
    }

    // Un abonnement actif existe déjà pour ce client ? On le met à jour.
    const existing = await db.subscription.findFirst({
      where: { clientId: doc.clientId, status: SubscriptionStatus.ACTIVE },
      select: { id: true },
    });

    let subId: string;
    if (existing) {
      await updateSubscription(
        existing.id,
        {
          label: line.description,
          amountCents: line.unitPriceCents,
          billingDay: line.billingDay,
        },
        db,
      );
      subId = existing.id;
      updated += 1;
    } else {
      const sub = await createSubscription(
        {
          clientId: doc.clientId,
          serviceId: line.serviceId,
          label: line.description,
          amountCents: line.unitPriceCents,
          billingDay: line.billingDay,
          startDate: new Date(),
          skipCurrentPeriod: true,
        },
        db,
      );
      subId = sub.id;
      created += 1;
    }

    await db.invoiceLine.update({
      where: { id: line.id },
      data: { subscriptionId: subId },
    });

    subscriptionIds.push(subId);
  }

  return { created, updated, subscriptionIds };
}
