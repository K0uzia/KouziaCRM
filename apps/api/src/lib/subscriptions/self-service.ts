import type { Subscription } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { formatLongDate } from "@/lib/money.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { alertAdmin } from "@/lib/stripe/alert.js";
import { nonRenewalDeadline, isRenewal } from "@/lib/subscriptions/renewal-reminder.js";

/** Abonnement géré dans le portail Stripe (prélevé par Stripe). */
export function isStripeManaged(sub: Pick<Subscription, "collectionMethod" | "stripeSubscriptionId">): boolean {
  return sub.collectionMethod === "STRIPE" && Boolean(sub.stripeSubscriptionId);
}

type PortalSubscription = Pick<
  Subscription,
  | "status"
  | "collectionMethod"
  | "stripeSubscriptionId"
  | "stripeStatus"
  | "stripeCancelAt"
  | "endDate"
  | "cancellationRequestedAt"
  | "billingInterval"
  | "startDate"
  | "nextInvoiceAt"
>;

/**
 * Champs de gestion d'un abonnement pour /suivi (format convenu avec le site) :
 * - manage : STRIPE_PORTAL (portail Stripe, y compris résiliation programmée), REQUEST (demande
 *   de résiliation d'un abonnement par virement), null (demande faite ou fin actée) ;
 * - paymentIssue : seulement pour un abonnement prélevé par Stripe ;
 * - renewalDeadline : abonnement annuel, date limite pour refuser la reconduction (même calcul que l'e-mail).
 */
/** billed : abonnement déjà facturé au moins une fois. Jamais facturé (1re échéance différée) : pas de reconduction. */
export function portalSubscriptionFields(sub: PortalSubscription, noticeDays: number, now = new Date(), billed = true) {
  const stripe = isStripeManaged(sub);
  const endsAt = sub.stripeCancelAt ?? (sub.endDate && sub.endDate > now ? sub.endDate : null);
  const paymentIssue = stripe
    ? sub.stripeStatus === "unpaid"
      ? ("UNPAID" as const)
      : sub.stripeStatus === "past_due"
        ? ("LATE" as const)
        : null
    : null;
  const manage = stripe
    ? ("STRIPE_PORTAL" as const)
    : !sub.cancellationRequestedAt && !endsAt
      ? ("REQUEST" as const)
      : null;
  const annualOpen =
    sub.billingInterval === "YEAR" && sub.status === "ACTIVE" && !endsAt && !sub.cancellationRequestedAt && billed && isRenewal(sub);
  return {
    status: sub.status === "PAUSED" ? ("PAUSED" as const) : ("ACTIVE" as const),
    paymentIssue,
    cancelAt: endsAt ? endsAt.toISOString() : null,
    cancellationRequestedAt: sub.cancellationRequestedAt ? sub.cancellationRequestedAt.toISOString() : null,
    manage,
    ...(annualOpen ? { renewalDeadline: nonRenewalDeadline(sub.nextInvoiceAt, noticeDays).toISOString() } : {}),
  };
}

export class CancelRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * Demande de résiliation depuis /suivi pour un abonnement par virement : notée une fois,
 * accusé de réception par e-mail au client (support durable) et alerte admin. L'admin clôture à la main.
 */
export async function requestSubscriptionCancellation(subscriptionId: string, now = new Date()): Promise<Date> {
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: { client: true } });
  if (isStripeManaged(sub)) {
    throw new CancelRequestError("Cet abonnement se résilie depuis « Gérer mon abonnement ».", 409);
  }
  if (sub.cancellationRequestedAt) {
    throw new CancelRequestError(
      `Demande de résiliation déjà enregistrée le ${formatLongDate(sub.cancellationRequestedAt)}.`,
      409,
    );
  }
  const claimed = await prisma.subscription.updateMany({
    where: { id: sub.id, cancellationRequestedAt: null },
    data: { cancellationRequestedAt: now },
  });
  if (claimed.count === 0) throw new CancelRequestError("Demande de résiliation déjà enregistrée.", 409);

  const who = sub.client.displayName;
  await alertAdmin(
    `Demande de résiliation : ${who}`,
    `${who} demande la résiliation de l'abonnement « ${sub.label} » depuis son espace client (le ${formatLongDate(now)}). ` +
      "Clôturez l'abonnement dans l'ERP (Abonnements) et confirmez la date de fin au client.",
  );

  const to = decryptOptional(sub.client.emailEncrypted);
  if (to) {
    const settings = await getCompanySettings();
    const brand = buildEmailBrand(settings);
    const name = (sub.client.firstName ?? sub.client.displayName)?.trim();
    const text = [
      name ? `Bonjour ${name},` : "Bonjour,",
      "",
      `Nous avons bien reçu, le ${formatLongDate(now)}, votre demande de résiliation de l'abonnement « ${sub.label} ».`,
      "",
      "Nous vous confirmerons par e-mail la date de fin de l'abonnement.",
      "",
      "Cet e-mail vaut accusé de réception de votre demande. Conservez-le.",
      "",
      "Une question ? Répondez simplement à cet e-mail.",
      "",
      formatPlainTextSignature(settings, brand),
    ].join("\n");
    await mailEnqueue({
      to,
      subject: `Demande de résiliation reçue : ${sub.label}`,
      text,
      html: renderEmailHtml({ text, brand, colors: { brandPrimaryColor: settings.brandPrimaryColor } }),
      clientId: sub.clientId,
      kind: "subscription_cancel_request",
      bodyTextForMessage: text,
    });
  } else {
    console.warn(`[subscriptions] accusé de résiliation non envoyé : client sans e-mail (${sub.id})`);
  }
  return now;
}
