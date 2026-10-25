import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { recurringDiscountSummary } from "@/lib/quotes/recurring-discount.js";
import { lineFirstInvoiceAt } from "@/lib/subscriptions/start.js";
import { prisma } from "@/lib/prisma.js";
import { BILLABLE_LINES_WHERE } from "@/lib/quotes/quote-options.js";
import {
  createSubscription,
  updateSubscription,
  nextPeriodDate,
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
  /**
   * Départ de l'abonnement (par défaut : maintenant). Consommateur sans demande d'exécution
   * anticipée : lendemain du délai de rétractation (CGV art. 9.5), 1re échéance à cette date.
   */
  startDate?: Date;
  /** Seulement ces lignes (rattachement d'un avenant : les autres lignes du devis restent à rattacher). */
  onlyLineIds?: string[];
  /**
   * Avenant : le document facture-t-il la période révisée maintenant ? Par défaut, oui pour une facture, non pour un
   * devis (sa période n'est facturée qu'à sa conversion en facture, qui décale alors l'échéance).
   */
  periodBilledNow?: boolean;
};

/** Migration qui a introduit les avenants ciblés (InvoiceLine.revisesSubscriptionId). */
const TARGETED_REVISIONS_MIGRATION = "20261112090000_avenant_abonnement";
let cutoffCache: Date | null | undefined;

/**
 * Heure d'application de cette migration : un document créé avant ne pouvait pas marquer un avenant. Base créée
 * sans historique de migrations (tests, db push) : null, aucun document n'est ancien.
 */
export async function targetedRevisionsCutoff(db: Db = prisma): Promise<Date | null> {
  if (cutoffCache !== undefined) return cutoffCache;
  try {
    const rows = await db.$queryRaw<Array<{ finished_at: Date | string | number | null }>>`
      SELECT finished_at FROM _prisma_migrations WHERE migration_name = ${TARGETED_REVISIONS_MIGRATION} AND finished_at IS NOT NULL LIMIT 1`;
    const v = rows[0]?.finished_at;
    cutoffCache = v == null ? null : new Date(v);
  } catch {
    // Historique illisible (base créée par db push) : tout document est traité comme nouveau, jamais de révision
    // au hasard. En production, migrate deploy tient toujours cette table.
    console.warn("[subscriptions] _prisma_migrations illisible : aucun devis n'est traité comme antérieur aux avenants ciblés");
    cutoffCache = null;
  }
  return cutoffCache;
}

/** Tests : oublie l'heure mémorisée. */
export function resetTargetedRevisionsCutoff(): void {
  cutoffCache = undefined;
}

/** Nom court d'une ligne du catalogue (« Nom : description » → « Nom »). */
function shortName(description: string): string {
  return description.split(" : ")[0]!.trim();
}

/**
 * Document antérieur aux avenants ciblés : comportement d'avant (un seul abonnement par client, lignes
 * additionnées, l'abonnement actif est révisé). Si le client a désormais plusieurs abonnements actifs, rien
 * n'est écrasé : les lignes restent sans abonnement et le tableau de bord demande de les rattacher.
 */
async function activateLegacyDocument(
  doc: { clientId: string },
  pending: Array<{ id: string; description: string; unitPriceCents: number; serviceId: string | null; billingDay: number | null; billingInterval: string | null }>,
  linked: string[],
  db: Db,
  opts: ActivateSubscriptionsOptions,
): Promise<ActivateSubscriptionsResult> {
  const actives = await db.subscription.findMany({
    where: { clientId: doc.clientId, status: SubscriptionStatus.ACTIVE },
    select: { id: true, nextInvoiceAt: true, stripeSubscriptionId: true },
  });
  if (actives.length > 1) return { created: 0, updated: 0, subscriptionIds: linked, createdIds: [] };
  const intervals = new Set(pending.map((l) => normalizeInterval(l.billingInterval)));
  if (intervals.size > 1) {
    throw new SubscriptionError(
      "Devis antérieur aux abonnements multiples : ses lignes d'abonnement doivent avoir la même périodicité.",
    );
  }
  const first = pending[0]!;
  const billingInterval = normalizeInterval(first.billingInterval);
  const amountCents = pending.reduce((sum, l) => sum + l.unitPriceCents, 0);
  const label = pending.length === 1 ? first.description : pending.map((l) => shortName(l.description)).join(" + ");
  const existing = actives[0];
  let subId: string;
  let created = 0;
  let updated = 0;
  const createdIds: string[] = [];
  if (existing) {
    await updateSubscription(existing.id, { label, amountCents, billingDay: first.billingDay!, billingInterval }, db);
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
        startDate: opts.startDate ?? new Date(),
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
  await db.invoiceLine.updateMany({ where: { id: { in: pending.map((l) => l.id) } }, data: { subscriptionId: subId } });
  return { created, updated, subscriptionIds: [...new Set([...linked, subId])], createdIds };
}

/** Période révisée facturée par un document : l'échéance de l'abonnement avance d'une période (fin de mois bornée). */
export async function shiftRevisedPeriod(subscriptionId: string, db: Db = prisma): Promise<void> {
  const sub = await db.subscription.findUnique({ where: { id: subscriptionId }, select: { nextInvoiceAt: true, billingInterval: true, stripeSubscriptionId: true } });
  if (!sub || sub.stripeSubscriptionId) return;
  await db.subscription.update({ where: { id: subscriptionId }, data: { nextInvoiceAt: nextPeriodDate(sub.nextInvoiceAt, periodMonths(sub.billingInterval)) } });
}

/**
 * Abonnements des lignes `isSubscription` d'un document. Un client peut avoir plusieurs abonnements actifs
 * (ex. maintenance mensuelle et e-mails annuels) : chaque ligne crée le sien, avec sa périodicité. Une ligne
 * de devis d'avenant (revisesSubscriptionId) met à jour l'abonnement qu'elle vise, et lui seul.
 * Idempotent via InvoiceLine.subscriptionId.
 */
export async function activateSubscriptionsFromDocument(
  documentId: string,
  db: Db = prisma,
  opts: ActivateSubscriptionsOptions = {},
): Promise<ActivateSubscriptionsResult> {
  const doc = await db.invoice.findUnique({
    where: { id: documentId },
    include: {
      // Devis à propositions : seules les lignes de la proposition retenue créent un abonnement.
      lines: { where: BILLABLE_LINES_WHERE, orderBy: { position: "asc" } },
    },
  });
  if (!doc) {
    throw new SubscriptionError("Document introuvable");
  }

  const subscriptionLines = doc.lines.filter((l) => l.isSubscription);
  const linked = [...new Set(subscriptionLines.map((l) => l.subscriptionId).filter((id): id is string => Boolean(id)))];
  const pending = subscriptionLines.filter((l) => !l.subscriptionId && (!opts.onlyLineIds || opts.onlyLineIds.includes(l.id)));
  if (pending.length === 0) return { created: 0, updated: 0, subscriptionIds: linked, createdIds: [] };

  for (const line of pending) {
    if (!line.serviceId) {
      throw new SubscriptionError(`Ligne « ${line.description} » : prestation requise`);
    }
  }
  // Jour de prélèvement : celui de la ligne (exception), sinon celui du client, sinon le 1er.
  const client = await db.client.findUnique({ where: { id: doc.clientId }, select: { billingDay: true } });
  for (const line of pending) line.billingDay ??= client?.billingDay ?? 1;

  // Document créé avant les avenants ciblés, sans ligne d'avenant marquée : comportement d'avant.
  const cutoff = await targetedRevisionsCutoff(db);
  if (cutoff && doc.createdAt < cutoff && pending.every((l) => !l.revisesSubscriptionId)) {
    return activateLegacyDocument(doc, pending, linked, db, opts);
  }

  let created = 0;
  let updated = 0;
  const createdIds: string[] = [];
  const ids: string[] = [];
  // Devis en mode récurrent (24/10/2026) : ses lignes d'abonnement forment UN abonnement (montants additionnés).
  // Période, engagement, départ et jour sont les mêmes sur chaque ligne (validés à l'enregistrement).
  const grouped = doc.billingMode === "RECURRING" ? pending.filter((l) => !l.revisesSubscriptionId) : [];
  if (grouped.length > 0) {
    const first = grouped[0]!;
    const startDate = opts.startDate ?? new Date();
    const firstInvoiceAt = doc.documentType === "QUOTE" ? lineFirstInvoiceAt(first, first.billingDay!, startDate) : null;
    const sub = await createSubscription(
      {
        clientId: doc.clientId,
        serviceId: first.serviceId!,
        label: grouped.length === 1 ? first.description : grouped.map((l) => shortName(l.description)).join(" + "),
        amountCents: grouped.reduce((sum, l) => sum + l.unitPriceCents, 0),
        billingDay: first.billingDay!,
        billingInterval: normalizeInterval(first.billingInterval),
        startDate,
        commitmentMonths: first.commitmentMonths,
        commitmentStart: doc.documentType === "QUOTE" ? (doc.quoteDecidedAt ?? startDate) : startDate,
        ...(firstInvoiceAt ? { firstInvoiceAt } : { skipCurrentPeriod: !opts.firstPeriodNow, firstPeriodNow: opts.firstPeriodNow }),
        ...(opts.awaitStripe ? { collectionMethod: SubscriptionCollectionMethod.STRIPE } : {}),
      },
      db,
    );
    // Remise du devis (R1) : sur les premières échéances de l'abonnement, puis tarif plein.
    const discount = recurringDiscountSummary(doc, sub.amountCents, first.billingInterval, first.commitmentMonths);
    if (discount) {
      await db.subscription.update({
        where: { id: sub.id },
        data: { discountKind: discount.kind, discountValue: discount.value, discountPeriods: discount.periods, discountPeriodsBilled: 0 },
      });
    }
    await db.invoiceLine.updateMany({ where: { id: { in: grouped.map((l) => l.id) } }, data: { subscriptionId: sub.id } });
    created += 1;
    createdIds.push(sub.id);
    ids.push(sub.id);
  }
  for (const line of pending.filter((l) => !grouped.includes(l))) {
    const billingInterval = normalizeInterval(line.billingInterval);
    let subId: string;
    if (line.revisesSubscriptionId) {
      // Avenant : l'abonnement visé, appartenant à ce client et encore actif.
      const target = await db.subscription.findUnique({
        where: { id: line.revisesSubscriptionId },
        select: { id: true, clientId: true, status: true, nextInvoiceAt: true, stripeSubscriptionId: true },
      });
      if (!target || target.clientId !== doc.clientId || target.status !== SubscriptionStatus.ACTIVE) {
        throw new SubscriptionError(`Ligne « ${line.description} » : l'abonnement révisé n'est plus actif pour ce client`);
      }
      await updateSubscription(
        target.id,
        { label: line.description, amountCents: line.unitPriceCents, billingDay: line.billingDay!, billingInterval },
        db,
      );
      // Le document facture déjà la période (facture) : l'échéance suivante est décalée d'une période, sinon elle serait
      // facturée deux fois. Un devis signé ne facture rien tant qu'il n'est pas converti (audit du 25/10/2026 : décaler
      // à la signature sautait une période si le devis restait sans facture). Un prélèvement Stripe suit son calendrier.
      if (!opts.firstPeriodNow && !target.stripeSubscriptionId) {
        if (opts.periodBilledNow ?? doc.documentType !== "QUOTE") {
          await shiftRevisedPeriod(target.id, db);
        } else if (opts.periodBilledNow === undefined) {
          // Décalage reporté à la conversion en facture : marqueur de la ligne, pour ne décaler qu'une fois et jamais
          // un devis signé avant ce fonctionnement (déjà décalé à sa signature).
          await db.invoiceLine.update({ where: { id: line.id }, data: { revisionShiftDeferred: true } });
        }
      }
      subId = target.id;
      updated += 1;
    } else {
      const startDate = opts.startDate ?? new Date();
      // Devis : départ choisi sur la ligne (date précise, mois offerts) ; sinon le départ habituel.
      const firstInvoiceAt = doc.documentType === "QUOTE" ? lineFirstInvoiceAt(line, line.billingDay!, startDate) : null;
      const sub = await createSubscription(
        {
          clientId: doc.clientId,
          serviceId: line.serviceId!,
          label: line.description,
          amountCents: line.unitPriceCents,
          billingDay: line.billingDay!,
          billingInterval,
          startDate,
          commitmentMonths: line.commitmentMonths,
          // L'engagement court depuis la signature du devis, même si la facturation démarre à la livraison.
          commitmentStart: doc.documentType === "QUOTE" ? (doc.quoteDecidedAt ?? startDate) : startDate,
          ...(firstInvoiceAt
            ? { firstInvoiceAt }
            : { skipCurrentPeriod: !opts.firstPeriodNow, firstPeriodNow: opts.firstPeriodNow }),
          ...(opts.awaitStripe ? { collectionMethod: SubscriptionCollectionMethod.STRIPE } : {}),
        },
        db,
      );
      subId = sub.id;
      created += 1;
      createdIds.push(sub.id);
    }
    await db.invoiceLine.update({ where: { id: line.id }, data: { subscriptionId: subId } });
    ids.push(subId);
  }

  return { created, updated, subscriptionIds: [...new Set([...linked, ...ids])], createdIds };
}

/**
 * Avenants à rattacher : lignes d'abonnement d'un devis accepté, antérieur aux avenants ciblés, restées sans
 * abonnement parce que le client en avait déjà plusieurs (rien n'a été écrasé). Liste calculée, rien de stocké.
 */
export async function listRevisionsToAttach() {
  const cutoff = await targetedRevisionsCutoff();
  if (!cutoff) return [];
  const lines = await prisma.invoiceLine.findMany({
    where: {
      isSubscription: true,
      subscriptionId: null,
      revisesSubscriptionId: null,
      invoice: { documentType: "QUOTE", quoteStatus: "ACCEPTED", createdAt: { lt: cutoff } },
    },
    orderBy: { position: "asc" },
    select: {
      id: true,
      description: true,
      unitPriceCents: true,
      billingInterval: true,
      invoice: { select: { id: true, number: true, clientId: true, client: { select: { displayName: true } } } },
    },
  });
  const out = [];
  for (const l of lines) {
    const actives = await prisma.subscription.findMany({
      where: { clientId: l.invoice.clientId, status: SubscriptionStatus.ACTIVE },
      select: { id: true, label: true, amountCents: true, billingInterval: true },
      orderBy: { startDate: "asc" },
    });
    if (actives.length < 2) continue;
    out.push({
      lineId: l.id,
      quoteId: l.invoice.id,
      quoteNumber: l.invoice.number,
      displayName: l.invoice.client.displayName,
      description: l.description,
      amountCents: l.unitPriceCents,
      billingInterval: normalizeInterval(l.billingInterval),
      subscriptions: actives.map((s) => ({ ...s, billingInterval: normalizeInterval(s.billingInterval) })),
    });
  }
  return out;
}

/**
 * Rattache une ligne d'avenant à l'abonnement choisi par l'admin, puis applique la révision (même règle qu'un
 * avenant ciblé). La ligne de la facture issue du devis, s'il y en a une, est reliée au même abonnement.
 */
export async function attachRevisionLine(subscriptionId: string, lineId: string) {
  return prisma.$transaction(async (tx) => {
    const line = await tx.invoiceLine.findUnique({
      where: { id: lineId },
      select: { id: true, position: true, isSubscription: true, subscriptionId: true, invoice: { select: { id: true, clientId: true, documentType: true, quoteStatus: true } } },
    });
    if (!line || !line.isSubscription || line.subscriptionId || line.invoice.documentType !== "QUOTE" || line.invoice.quoteStatus !== "ACCEPTED") {
      throw new SubscriptionError("Ligne d'avenant introuvable ou déjà rattachée");
    }
    const sub = await tx.subscription.findUnique({ where: { id: subscriptionId }, select: { clientId: true, status: true } });
    if (!sub || sub.clientId !== line.invoice.clientId || sub.status !== SubscriptionStatus.ACTIVE) {
      throw new SubscriptionError("Abonnement introuvable, clôturé ou d'un autre client");
    }
    await tx.invoiceLine.update({ where: { id: line.id }, data: { revisesSubscriptionId: subscriptionId } });
    // Pas de décalage de l'échéance si l'avenant ne facture aucune période : devis d'abonnement seul, jamais
    // converti en facture (la période révisée sera facturée par l'abonnement, à sa date).
    const [quoteLines, invoiced] = await Promise.all([
      tx.invoiceLine.findMany({ where: { invoiceId: line.invoice.id }, select: { isSubscription: true } }),
      tx.invoice.count({ where: { quoteId: line.invoice.id, documentType: "INVOICE" } }),
    ]);
    const billsPeriod = invoiced > 0 || quoteLines.some((l) => !l.isSubscription);
    const result = await activateSubscriptionsFromDocument(line.invoice.id, tx, { firstPeriodNow: !billsPeriod, periodBilledNow: billsPeriod, onlyLineIds: [line.id] });
    await tx.invoiceLine.updateMany({
      where: { invoice: { quoteId: line.invoice.id, documentType: "INVOICE" }, isSubscription: true, position: line.position, subscriptionId: null },
      data: { subscriptionId },
    });
    return result;
  });
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
      await sendSubscriptionSetupEmail(id, { family: "payment_link", origin: "CLIENT_ACTION", clientWaiting: true });
    } catch (err) {
      await prisma.subscription.update({ where: { id }, data: { setupLinkSentAt: null } });
      console.error("[subscriptions] envoi lien prélèvement Stripe", err);
    }
  }
}
