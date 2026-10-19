import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { formatEUR, formatLongDate } from "@/lib/money.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import type { EmailBrand } from "@/lib/email/templates.js";
import type { CompanySettings } from "@prisma/client";
import { subscriptionPaymentUrl } from "@/lib/stripe/portal.js";

/**
 * Information annuelle de reconduction (Code de la consommation, L215-1) : e-mail dédié, au plus
 * tôt 3 mois et au plus tard 1 mois avant la date limite pour refuser la reconduction. Envoyé
 * 45 jours avant cette date limite, au milieu de la fenêtre, pour tous les clients.
 */
export const NOTICE_DAYS_BEFORE_DEADLINE = 45;
const DAY_MS = 86_400_000;
/** En deçà, l'échéance est la 1re facture de l'abonnement, pas un renouvellement. */
const MIN_ELAPSED_FOR_RENEWAL_MS = 300 * DAY_MS;

const fmtDate = formatLongDate;

/** Échéance qui est un renouvellement (et non la 1re facture de l'abonnement). */
export function isRenewal(s: { nextInvoiceAt: Date; startDate: Date }): boolean {
  return s.nextInvoiceAt.getTime() - s.startDate.getTime() >= MIN_ELAPSED_FOR_RENEWAL_MS;
}

/** Avis avant la 1re échéance d'un abonnement à démarrage différé (ex. une année offerte) : 30 jours avant. */
export const FIRST_CHARGE_NOTICE_DAYS = 30;
/** En deçà, la 1re échéance suit le début de près : pas de démarrage différé, pas d'avis dédié. */
const DEFERRED_MIN_MS = 30 * DAY_MS;

/**
 * Abonnements déjà facturés au moins une fois : facture émise par l'abonnement (ou miroir Stripe), ou ligne d'une
 * facture qui lui est rattachée (1re période facturée par la facture du devis). Un abonnement jamais facturé n'a
 * pas encore eu de 1re échéance : ce n'est pas une reconduction.
 */
export async function billedSubscriptionIds(subs: Array<{ id: string; lastInvoiceId: string | null }>): Promise<Set<string>> {
  const billed = new Set(subs.filter((s) => s.lastInvoiceId).map((s) => s.id));
  const ids = subs.map((s) => s.id);
  if (ids.length === 0) return billed;
  const invoices = await prisma.invoice.findMany({
    where: {
      OR: [
        { subscriptionId: { in: ids } },
        { documentType: "INVOICE", lines: { some: { subscriptionId: { in: ids } } } },
      ],
    },
    select: { subscriptionId: true, lines: { where: { subscriptionId: { in: ids } }, select: { subscriptionId: true } } },
  });
  for (const inv of invoices) {
    if (inv.subscriptionId) billed.add(inv.subscriptionId);
    for (const l of inv.lines) if (l.subscriptionId) billed.add(l.subscriptionId);
  }
  return billed;
}

/** Date limite pour refuser la reconduction : N jours avant le renouvellement (1 = la veille). */
export function nonRenewalDeadline(renewalDate: Date, noticeDays: number): Date {
  return new Date(renewalDate.getTime() - Math.max(0, noticeDays) * DAY_MS);
}

export function renderRenewalReminderEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml" | "brandPrimaryColor" | "brandSecondaryColor">;
  clientName: string;
  clientFirstName?: string | null;
  label: string;
  amountCents: number;
  renewalDate: Date;
  deadline: Date;
  /** Abonnement prélevé par Stripe : lien vers l'espace de gestion (résiliation en ligne). */
  manageUrl?: string | null;
}) {
  const name = (opts.clientFirstName ?? opts.clientName)?.trim();
  const date = fmtDate(opts.renewalDate);
  const callout = `Date limite pour refuser la reconduction : ${fmtDate(opts.deadline)}`;
  const how = opts.manageUrl
    ? [
        "Il vous suffit de résilier depuis l'espace de gestion de votre abonnement, ou de répondre à cet e-mail :",
        "",
        opts.manageUrl,
      ]
    : ["Il vous suffit de répondre à cet e-mail."];
  const subject = `Reconduction de votre abonnement annuel le ${date}`;
  const text = [
    name ? `Bonjour ${name},` : "Bonjour,",
    "",
    `Votre abonnement annuel « ${opts.label} » sera reconduit automatiquement le ${date}, pour un an, au prix de ${formatEUR(opts.amountCents)}.`,
    "",
    callout,
    "",
    "Vous pouvez refuser cette reconduction, sans frais et sans justification, jusqu'à cette date.",
    ...how,
    "",
    opts.manageUrl
      ? `Sans démarche de votre part, l'abonnement sera reconduit et le prélèvement de ${formatEUR(opts.amountCents)} aura lieu le ${date}.`
      : `Sans démarche de votre part, l'abonnement sera reconduit et une facture de ${formatEUR(opts.amountCents)} vous sera adressée le ${date}.`,
    "",
    formatPlainTextSignature(opts.settings, opts.brand),
  ].join("\n");
  const html = renderEmailHtml({
    text,
    brand: opts.brand,
    colors: { brandPrimaryColor: opts.settings.brandPrimaryColor, brandSecondaryColor: opts.settings.brandSecondaryColor },
    callout,
    paymentUrl: opts.manageUrl,
    paymentLabel: "Gérer mon abonnement",
  });
  return { subject, text, html };
}

/**
 * Information de reconduction des abonnements annuels, facturés par l'ERP ou prélevés par Stripe
 * (pour Stripe, nextInvoiceAt suit la fin de la période en cours). Ni pour un abonnement suspendu,
 * ni pour une résiliation déjà programmée. Idempotent par échéance (renewalReminderSentFor).
 * @returns nombre d'e-mails enfilés.
 */
export async function sendDueRenewalReminders(now: Date = new Date()): Promise<number> {
  if (!(await isSmtpConfigured())) return 0;

  const settings = await getCompanySettings();
  // Date limite dans moins de 45 jours : nextInvoiceAt avant maintenant + 45 jours + délai de la date limite.
  const horizon = new Date(
    now.getTime() + (NOTICE_DAYS_BEFORE_DEADLINE + Math.max(0, settings.nonRenewalNoticeDays)) * DAY_MS,
  );
  const candidates = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      billingInterval: "YEAR",
      stripeCancelAt: null,
      cancellationRequestedAt: null,
      nextInvoiceAt: { gt: now, lte: horizon },
    },
    include: { client: true },
  });

  // Abonnement jamais facturé (1re échéance différée, ex. une année offerte) : avis de 1re échéance, pas de reconduction.
  const billed = await billedSubscriptionIds(candidates);
  const due = candidates.filter(
    (s) =>
      s.renewalReminderSentFor?.getTime() !== s.nextInvoiceAt.getTime() &&
      isRenewal(s) &&
      billed.has(s.id) &&
      // Échéance encore couverte par l'engagement : pas une reconduction, rien à refuser.
      !(s.commitmentEndsAt && s.nextInvoiceAt < s.commitmentEndsAt) &&
      (!s.endDate || s.endDate >= s.nextInvoiceAt),
  );
  if (due.length === 0) return 0;

  const brand = buildEmailBrand(settings);
  let queued = 0;
  for (const sub of due) {
    const to = decryptOptional(sub.client.emailEncrypted);
    if (!to) {
      console.warn(`[subscriptions] information de reconduction ignorée : client sans e-mail (${sub.id})`);
      continue;
    }
    const content = renderRenewalReminderEmail({
      brand,
      settings,
      clientName: sub.client.displayName,
      clientFirstName: sub.client.firstName,
      label: sub.label,
      amountCents: sub.amountCents,
      renewalDate: sub.nextInvoiceAt,
      deadline: nonRenewalDeadline(sub.nextInvoiceAt, settings.nonRenewalNoticeDays),
      manageUrl:
        sub.collectionMethod === SubscriptionCollectionMethod.STRIPE && sub.stripeSubscriptionId
          ? await subscriptionPaymentUrl(sub)
          : null,
    });
    await mailEnqueue({
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      clientId: sub.clientId,
      kind: "subscription_renewal",
      bodyTextForMessage: content.text,
    });
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { renewalReminderSentFor: sub.nextInvoiceAt },
    });
    queued += 1;
  }
  return queued;
}

export function renderFirstChargeNoticeEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml" | "brandPrimaryColor" | "brandSecondaryColor">;
  clientName: string;
  clientFirstName?: string | null;
  label: string;
  amountCents: number;
  billingInterval: string | null;
  firstChargeDate: Date;
  /** Prélèvement Stripe : 1er prélèvement à cette date ; lien vers l'espace de gestion. Sinon, facture à cette date. */
  manageUrl?: string | null;
  stripe: boolean;
}) {
  const name = (opts.clientFirstName ?? opts.clientName)?.trim();
  const date = fmtDate(opts.firstChargeDate);
  const period = opts.billingInterval === "YEAR" ? "par an" : "par mois";
  const callout = opts.stripe ? `1er prélèvement le ${date}` : `1re facture le ${date}`;
  const subject = opts.stripe ? `Votre abonnement « ${opts.label} » : 1er prélèvement le ${date}` : `Votre abonnement « ${opts.label} » : 1re facture le ${date}`;
  const text = [
    name ? `Bonjour ${name},` : "Bonjour,",
    "",
    `La 1re échéance de votre abonnement « ${opts.label} », de ${formatEUR(opts.amountCents)} ${period}, aura lieu le ${date}.`,
    "",
    callout,
    "",
    opts.stripe
      ? `Le prélèvement de ${formatEUR(opts.amountCents)} sera fait à cette date sur le moyen de paiement enregistré.`
      : `Une facture de ${formatEUR(opts.amountCents)} vous sera adressée à cette date.`,
    ...(opts.manageUrl
      ? ["Vous pouvez gérer ou résilier votre abonnement depuis son espace de gestion, ou répondre à cet e-mail :", "", opts.manageUrl]
      : ["Pour toute question, ou pour ne pas poursuivre, répondez simplement à cet e-mail."]),
    "",
    formatPlainTextSignature(opts.settings, opts.brand),
  ].join("\n");
  const html = renderEmailHtml({
    text,
    brand: opts.brand,
    colors: { brandPrimaryColor: opts.settings.brandPrimaryColor, brandSecondaryColor: opts.settings.brandSecondaryColor },
    callout,
    paymentUrl: opts.manageUrl,
    paymentLabel: "Gérer mon abonnement",
  });
  return { subject, text, html };
}

/**
 * Avis à J-30 de la 1re échéance d'un abonnement à démarrage différé (jamais facturé, 1re échéance au moins 30 jours
 * après le début), quelle que soit sa périodicité. Ni pour un abonnement suspendu, ni pour une résiliation
 * programmée ou demandée. Idempotent par échéance (renewalReminderSentFor).
 * @returns nombre d'e-mails enfilés.
 */
export async function sendDueFirstChargeNotices(now: Date = new Date()): Promise<number> {
  if (!(await isSmtpConfigured())) return 0;
  const horizon = new Date(now.getTime() + FIRST_CHARGE_NOTICE_DAYS * DAY_MS);
  const candidates = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      stripeCancelAt: null,
      cancellationRequestedAt: null,
      nextInvoiceAt: { gt: now, lte: horizon },
    },
    include: { client: true },
  });
  const billed = await billedSubscriptionIds(candidates);
  const due = candidates.filter(
    (s) =>
      !billed.has(s.id) &&
      s.nextInvoiceAt.getTime() - s.startDate.getTime() >= DEFERRED_MIN_MS &&
      s.renewalReminderSentFor?.getTime() !== s.nextInvoiceAt.getTime() &&
      (!s.endDate || s.endDate >= s.nextInvoiceAt),
  );
  if (due.length === 0) return 0;

  const settings = await getCompanySettings();
  const brand = buildEmailBrand(settings);
  let queued = 0;
  for (const sub of due) {
    const to = decryptOptional(sub.client.emailEncrypted);
    if (!to) {
      console.warn(`[subscriptions] avis de 1re échéance ignoré : client sans e-mail (${sub.id})`);
      continue;
    }
    const stripe = sub.collectionMethod === SubscriptionCollectionMethod.STRIPE;
    const content = renderFirstChargeNoticeEmail({
      brand,
      settings,
      clientName: sub.client.displayName,
      clientFirstName: sub.client.firstName,
      label: sub.label,
      amountCents: sub.amountCents,
      billingInterval: sub.billingInterval,
      firstChargeDate: sub.nextInvoiceAt,
      stripe,
      manageUrl: stripe && sub.stripeSubscriptionId ? await subscriptionPaymentUrl(sub) : null,
    });
    await mailEnqueue({
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      clientId: sub.clientId,
      kind: "subscription_first_charge",
      bodyTextForMessage: content.text,
    });
    await prisma.subscription.update({ where: { id: sub.id }, data: { renewalReminderSentFor: sub.nextInvoiceAt } });
    queued += 1;
  }
  return queued;
}
