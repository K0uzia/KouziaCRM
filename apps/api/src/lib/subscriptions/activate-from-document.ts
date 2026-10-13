import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import {
  createSubscription,
  updateSubscription,
  normalizeInterval,
  periodMonths,
  SubscriptionError,
  type Db,
} from "@/lib/subscriptions/subscription-service.js";

export type ActivateSubscriptionsResult = {
  created: number;
  updated: number;
  subscriptionIds: string[];
  /** Abonnements créés par ce document (hors mises à jour d'un abonnement existant). */
  createdIds: string[];
};

export type ActivateSubscriptionsOptions = {
  /**
   * Devis d'abonnement seul : le document ne facture rien, la 1re échéance est due tout de suite
   * et sera facturée par l'abonnement (Stripe ou facture ERP). Sinon, le document facture
   * lui-même la 1re période (skipCurrentPeriod).
   */
  firstPeriodNow?: boolean;
  /** Prélèvement Stripe attendu : les factures viendront de Stripe, jamais du cron ERP. */
  awaitStripe?: boolean;
};

/** Nom court d'une ligne du catalogue (« Nom : description » → « Nom »). */
function shortName(description: string): string {
  return description.split(" : ")[0]!.trim();
}

/**
 * Crée ou met à jour l'abonnement des lignes `isSubscription` d'un document.
 * Un seul abonnement actif par client : plusieurs lignes d'un même document forment un seul
 * abonnement (montants additionnés, même périodicité exigée). Si un abonnement actif existe
 * déjà, il est mis à jour au lieu d'en créer un second. Idempotent via InvoiceLine.subscriptionId.
 */
export async function activateSubscriptionsFromDocument(
  documentId: string,
  db: Db = prisma,
  opts: ActivateSubscriptionsOptions = {},
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
  const linked = [...new Set(subscriptionLines.map((l) => l.subscriptionId).filter((id): id is string => Boolean(id)))];
  const pending = subscriptionLines.filter((l) => !l.subscriptionId);
  if (pending.length === 0) return { created: 0, updated: 0, subscriptionIds: linked, createdIds: [] };

  for (const line of pending) {
    if (!line.serviceId || !line.billingDay) {
      throw new SubscriptionError(
        `Ligne « ${line.description} » : prestation et jour de facturation requis`,
      );
    }
  }
  const intervals = new Set(pending.map((l) => normalizeInterval(l.billingInterval)));
  if (intervals.size > 1) {
    throw new SubscriptionError(
      "Un seul abonnement par client : les lignes d'abonnement d'un document doivent avoir la même périodicité (toutes mensuelles ou toutes annuelles).",
    );
  }

  const first = pending[0]!;
  const billingInterval = normalizeInterval(first.billingInterval);
  const amountCents = pending.reduce((sum, l) => sum + l.unitPriceCents, 0);
  const label = pending.length === 1 ? first.description : pending.map((l) => shortName(l.description)).join(" + ");

  // Un abonnement actif existe déjà pour ce client ? On le met à jour.
  const existing = await db.subscription.findFirst({
    where: { clientId: doc.clientId, status: SubscriptionStatus.ACTIVE },
    select: { id: true, nextInvoiceAt: true, stripeSubscriptionId: true },
  });

  let subId: string;
  let created = 0;
  let updated = 0;
  const createdIds: string[] = [];
  if (existing) {
    await updateSubscription(
      existing.id,
      { label, amountCents, billingDay: first.billingDay!, billingInterval },
      db,
    );
    // Le document facture déjà une période (facture, ou devis qui inclut la 1re échéance) :
    // l'échéance suivante de l'abonnement est décalée d'une période, sinon elle serait facturée
    // deux fois. Un prélèvement Stripe suit son propre calendrier : on n'y touche pas.
    if (!opts.firstPeriodNow && !existing.stripeSubscriptionId) {
      const next = new Date(existing.nextInvoiceAt);
      next.setMonth(next.getMonth() + periodMonths(billingInterval));
      await db.subscription.update({ where: { id: existing.id }, data: { nextInvoiceAt: next } });
    }
    subId = existing.id;
    updated = 1;
  } else {
    const sub = await createSubscription(
      {
        clientId: doc.clientId,
        serviceId: first.serviceId!,
        label,
        amountCents,
        billingDay: first.billingDay!,
        billingInterval,
        startDate: new Date(),
        skipCurrentPeriod: !opts.firstPeriodNow,
        firstPeriodNow: opts.firstPeriodNow,
        ...(opts.awaitStripe ? { collectionMethod: SubscriptionCollectionMethod.STRIPE } : {}),
      },
      db,
    );
    subId = sub.id;
    created = 1;
    createdIds.push(sub.id);
  }

  await db.invoiceLine.updateMany({
    where: { id: { in: pending.map((l) => l.id) } },
    data: { subscriptionId: subId },
  });

  return { created, updated, subscriptionIds: [...new Set([...linked, subId])], createdIds };
}

/**
 * Après commit : envoie le lien de prélèvement Stripe si le module est actif.
 * Un seul envoi par abonnement (setupLinkSentAt) : signature, conversion et émission
 * d'une facture ne le renvoient pas.
 */
export async function notifyStripeSubscriptionSetup(
  subscriptionIds: string[],
): Promise<void> {
  if (subscriptionIds.length === 0) return;
  const { getCompanySettings } = await import("@/lib/company.js");
  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled) return;
  const { sendSubscriptionSetupEmail } = await import("@/lib/stripe/billing.js");
  for (const id of new Set(subscriptionIds)) {
    // Réservation avant l'envoi : deux appels simultanés n'envoient qu'un e-mail.
    const claimed = await prisma.subscription.updateMany({
      where: { id, stripeSubscriptionId: null, setupLinkSentAt: null },
      data: { setupLinkSentAt: new Date() },
    });
    if (claimed.count !== 1) continue;
    try {
      await sendSubscriptionSetupEmail(id);
    } catch (err) {
      await prisma.subscription.update({ where: { id }, data: { setupLinkSentAt: null } });
      console.error("[subscriptions] envoi lien prélèvement Stripe", err);
    }
  }
}
