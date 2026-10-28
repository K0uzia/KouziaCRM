import type { Subscription } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { formatLongDate } from "@/lib/money.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import { templateText } from "@/lib/email/template-registry.js";
import { alertAdmin } from "@/lib/stripe/alert.js";
import { nonRenewalDeadline, isRenewal } from "@/lib/subscriptions/renewal-reminder.js";
import { CANCEL_NOTICE_MONTHS, cancellableTermOf, commitmentEndOf, currentTermEndOf, renewalNoticeOf } from "@/lib/subscriptions/commitment.js";

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
  | "commitmentEndsAt"
> &
  Partial<Pick<Subscription, "renewalReminderSentFor" | "renewalReminderSentAt">>;

/**
 * Champs de gestion d'un abonnement pour /suivi (format convenu avec le site) :
 * - manage : STRIPE_PORTAL (portail Stripe, y compris résiliation programmée), REQUEST (demande
 *   de résiliation d'un abonnement par virement), null (demande faite ou fin actée) ;
 * - paymentIssue : seulement pour un abonnement prélevé par Stripe ;
 * - renewalDeadline : abonnement annuel, date limite pour refuser la reconduction (même calcul que l'e-mail) ;
 * - commitmentEndsAt (ajout du 19/10/2026) : fin de l'engagement ;
 * - abonnement engagé (décision du 23/10/2026), quel que soit son rythme de paiement et même après l'engagement :
 *   manage vaut REQUEST tant que la demande de non-reconduction est possible (jamais STRIPE_PORTAL) ;
 *   currentTermEndsAt : fin de la période en cours (engagement, puis chaque année reconduite) ;
 *   cancelDeadline : currentTermEndsAt moins un mois (peut être passée) ;
 *   nonRenewalRequestedAt : date de la demande, ou null ;
 *   nonRenewalEffectiveAt : fin effective de la demande faite, sinon d'une demande faite aujourd'hui (date limite
 *   passée : fin de la période suivante) ;
 *   freeTermination (ajout du 28/10/2026) : true quand un client non professionnel n'a pas reçu à temps l'information de
 *   reconduction (L215-1) : il peut mettre fin à tout moment, nonRenewalEffectiveAt est alors la fin de la période déjà
 *   payée, sans préavis.
 */
/** billed : abonnement déjà facturé au moins une fois. Jamais facturé (1re échéance différée) : pas de reconduction. */
export function portalSubscriptionFields(sub: PortalSubscription, noticeDays: number, now = new Date(), billed = true, clientType?: string | null) {
  const stripe = isStripeManaged(sub);
  const endsAt = sub.stripeCancelAt ?? (sub.endDate && sub.endDate > now ? sub.endDate : null);
  const paymentIssue = stripe
    ? sub.stripeStatus === "unpaid"
      ? ("UNPAID" as const)
      : sub.stripeStatus === "past_due"
        ? ("LATE" as const)
        : null
    : null;
  const engaged = Boolean(sub.commitmentEndsAt);
  const open = !sub.cancellationRequestedAt && !endsAt;
  const manage = stripe && !engaged ? ("STRIPE_PORTAL" as const) : open ? ("REQUEST" as const) : null;
  const currentTermEndsAt = sub.commitmentEndsAt ? currentTermEndOf(sub.commitmentEndsAt, now) : null;
  // L215-1 : information de reconduction absente ou tardive pour un non-professionnel, fin à tout moment (28/10/2026).
  const term = sub.commitmentEndsAt ? cancellableTermOf(sub.commitmentEndsAt, sub.cancellationRequestedAt ?? now, renewalNoticeOf(sub, clientType)) : null;
  const effective = term?.termEndsAt ?? null;
  // Abonnement engagé : sa reconduction suit cancelDeadline, pas la date limite des annuels sans engagement.
  const annualOpen =
    sub.billingInterval === "YEAR" && sub.status === "ACTIVE" && open && billed && isRenewal(sub) && !engaged;
  return {
    status: sub.status === "PAUSED" ? ("PAUSED" as const) : ("ACTIVE" as const),
    paymentIssue,
    cancelAt: endsAt ? endsAt.toISOString() : null,
    cancellationRequestedAt: sub.cancellationRequestedAt ? sub.cancellationRequestedAt.toISOString() : null,
    manage,
    ...(annualOpen ? { renewalDeadline: nonRenewalDeadline(sub.nextInvoiceAt, noticeDays).toISOString() } : {}),
    ...(sub.commitmentEndsAt ? { commitmentEndsAt: sub.commitmentEndsAt.toISOString() } : {}),
    ...(currentTermEndsAt && effective
      ? {
          currentTermEndsAt: currentTermEndsAt.toISOString(),
          cancelDeadline: commitmentEndOf(currentTermEndsAt, -CANCEL_NOTICE_MONTHS).toISOString(),
          nonRenewalRequestedAt: sub.cancellationRequestedAt ? sub.cancellationRequestedAt.toISOString() : null,
          nonRenewalEffectiveAt: effective.toISOString(),
          ...(term?.freeTermination ? { freeTermination: true as const } : {}),
        }
      : {}),
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
  // Engagé : demande traitée par l'admin, même prélevé par Stripe (rien n'est coupé automatiquement), effet à la fin
  // de l'engagement ou de l'année reconduite visée par le préavis.
  const term = sub.commitmentEndsAt ? cancellableTermOf(sub.commitmentEndsAt, now, renewalNoticeOf(sub, sub.client.type)) : null;
  if (isStripeManaged(sub) && !term) {
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
      (term?.freeTermination
        ? `Client non professionnel sans information de reconduction faite à temps (art. L215-1) : il peut mettre fin à tout moment. Fin au ${formatLongDate(term.termEndsAt)}, fin de la période déjà payée, rien de plus n'est dû. Rien n'a été coupé dans Stripe. ` +
          "Programmez la fin de l'abonnement à cette date dans l'ERP (Abonnements)."
        : term
        ? `Abonnement engagé : fin au ${formatLongDate(term.termEndsAt)} (préavis d'un mois), échéances dues jusque-là. Rien n'a été coupé dans Stripe. ` +
          "Programmez la fin de l'abonnement à cette date dans l'ERP (Abonnements)."
        : "Clôturez l'abonnement dans l'ERP (Abonnements) et confirmez la date de fin au client."),
  );

  const to = decryptOptional(sub.client.emailEncrypted);
  if (to) {
    const { subject, text, html } = await cancelRequestContent(sub, now);
    await mailEnqueue({
      to,
      subject,
      text,
      html,
      clientId: sub.clientId,
      kind: "subscription_cancel_request",
      bodyTextForMessage: text,
    }, { review: { family: "cancellation_ack", origin: "CLIENT_ACTION", clientWaiting: true } });
  } else {
    console.warn(`[subscriptions] accusé de résiliation non envoyé : client sans e-mail (${sub.id})`);
  }
  return now;
}

/** Accusé de la demande de résiliation (aussi l'aperçu des Réglages) : sans effet de bord. */
export async function cancelRequestContent(
  sub: {
    label: string;
    commitmentEndsAt: Date | null;
    nextInvoiceAt?: Date;
    renewalReminderSentFor?: Date | null;
    renewalReminderSentAt?: Date | null;
    client: { firstName: string | null; displayName: string; type?: string | null };
  },
  now = new Date(),
): Promise<{ subject: string; text: string; html: string }> {
  const notice = sub.nextInvoiceAt ? renewalNoticeOf({ ...sub, nextInvoiceAt: sub.nextInvoiceAt }, sub.client.type) : undefined;
  const term = sub.commitmentEndsAt ? cancellableTermOf(sub.commitmentEndsAt, now, notice) : null;
  const settings = await getCompanySettings();
  const brand = buildEmailBrand(settings);
  const name = (sub.client.firstName ?? sub.client.displayName)?.trim();
  const salutation = name ? `Bonjour ${name},` : "Bonjour,";
  const received = `Nous avons bien reçu, le ${formatLongDate(now)}, votre demande de résiliation de l'abonnement « ${sub.label} ».`;
  // Abonnement engagé : la date de fin découle du contrat (fin de l'engagement ou de l'année reconduite).
  const end = term?.freeTermination
    ? `Votre abonnement prendra fin le ${formatLongDate(term.termEndsAt)}, à la fin de la période déjà payée. Faute d'avoir reçu à temps l'information sur sa reconduction, vous pouvez y mettre fin à tout moment (art. L215-1 du Code de la consommation) : rien de plus ne vous sera facturé.`
    : term
    ? `Votre abonnement prendra fin le ${formatLongDate(term.termEndsAt)}, ${
        sub.commitmentEndsAt!.getTime() === term.termEndsAt.getTime() ? "à la fin de votre engagement" : "à la fin de l'année en cours"
      }. Les échéances jusqu'à cette date restent dues. Rien ne change d'ici là.`
    : "Nous vous confirmerons par e-mail la date de fin de l'abonnement.";
  const ack = "Cet e-mail vaut accusé de réception de votre demande. Conservez-le.";
  // Modèle modifié dans Réglages (M3b) : date de fin et accusé restent des blocs fixes.
  const content = await templateText(
    "subscription.cancel_request",
    {
      salutation,
      prenom: sub.client.firstName?.trim() ?? "",
      client: sub.client.displayName,
      abonnement: sub.label,
      date_demande: formatLongDate(now),
      bloc_fin: end,
      bloc_accuse: ack,
    },
    {
      subject: `Demande de résiliation reçue : ${sub.label}`,
      body: [salutation, "", received, "", end, "", ack, "", "Une question ? Répondez simplement à cet e-mail."].join("\n"),
    },
  );
  const text = [content.body, "", formatPlainTextSignature(settings, brand)].join("\n");
  const html = renderEmailHtml({ text, brand, colors: { brandPrimaryColor: settings.brandPrimaryColor, brandSecondaryColor: settings.brandSecondaryColor } });
  return { subject: content.subject, text, html };
}
