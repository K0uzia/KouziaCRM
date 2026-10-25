import { nextPeriodAmountCents } from "@/lib/quotes/recurring-discount-calc.js";
import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { periodWord } from "@/lib/subscriptions/subscription-service.js";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { formatEUR, formatLongDate } from "@/lib/money.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { templateText } from "@/lib/email/template-registry.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import type { EmailBrand } from "@/lib/email/templates.js";
import type { CompanySettings } from "@prisma/client";
import { subscriptionPaymentUrl } from "@/lib/stripe/portal.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { cancellableTermOf } from "@/lib/subscriptions/commitment.js";

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

export async function renderRenewalReminderEmail(opts: {
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
  const salutation = name ? `Bonjour ${name},` : "Bonjour,";
  const intro = `Votre abonnement annuel « ${opts.label} » sera reconduit automatiquement le ${date}, pour un an, au prix de ${formatEUR(opts.amountCents)}.`;
  // Information de reconduction tacite : date limite, droit de refuser sans frais, démarche et conséquence (bloc fixe).
  const notice = [
    callout,
    "",
    "Vous pouvez refuser cette reconduction, sans frais et sans justification, jusqu'à cette date.",
    ...how,
    "",
    opts.manageUrl
      ? `Sans démarche de votre part, l'abonnement sera reconduit et le prélèvement de ${formatEUR(opts.amountCents)} aura lieu le ${date}.`
      : `Sans démarche de votre part, l'abonnement sera reconduit et une facture de ${formatEUR(opts.amountCents)} vous sera adressée le ${date}.`,
  ].join("\n");
  const content = await templateText(
    "subscription.renewal",
    { salutation, prenom: opts.clientFirstName?.trim() ?? "", client: opts.clientName, abonnement: opts.label, montant: formatEUR(opts.amountCents), date_reconduction: date, bloc_echeance: notice },
    { subject: `Reconduction de votre abonnement annuel le ${date}`, body: [salutation, "", intro, "", notice].join("\n") },
  );
  const subject = content.subject;
  const text = [content.body, "", formatPlainTextSignature(opts.settings, opts.brand)].join("\n");
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
      // Abonnement engagé : rappel de fin de période (sendDueTermEndReminders), pas d'annuel ordinaire.
      commitmentEndsAt: null,
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
    const content = await renderRenewalReminderEmail({
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
      documentId: sub.id,
      bodyTextForMessage: content.text,
    }, { review: { family: "subscription_notice", origin: "WORKER" } });
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { renewalReminderSentFor: sub.nextInvoiceAt },
    });
    queued += 1;
  }
  return queued;
}

export async function renderTermEndReminderEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml" | "brandPrimaryColor" | "brandSecondaryColor">;
  clientName: string;
  clientFirstName?: string | null;
  label: string;
  amountCents: number;
  billingInterval: string | null;
  termEndsAt: Date;
  deadline: Date;
  /** Fin de l'engagement (et non d'une année reconduite). */
  commitmentEnd: boolean;
  /** Espace client (/suivi), où se demande la non-reconduction. */
  portalUrl: string;
  /** Rachat (R3) : prix du catalogue, seulement à la fin du premier engagement d'une offre rachetable. */
  buyoutPriceCents?: number | null;
}) {
  const name = (opts.clientFirstName ?? opts.clientName)?.trim();
  const date = fmtDate(opts.termEndsAt);
  const callout = `Date limite pour demander la non-reconduction : ${fmtDate(opts.deadline)}`;
  // Rachat proposé (R3, texte accepté par Alexandre, relu dans « E-mails à valider » avant chaque envoi) : trois choix.
  const threeChoices = opts.commitmentEnd && opts.buyoutPriceCents != null;
  const salutation = name ? `Bonjour ${name},` : "Bonjour,";
  const common = { salutation, prenom: opts.clientFirstName?.trim() ?? "", client: opts.clientName, abonnement: opts.label };
  let content: { subject: string; body: string };
  if (threeChoices) {
    // Les trois choix (continuer, arrêter, racheter) forment un bloc fixe : prix, date limite et démarche compris.
    const choices = [
      "Trois possibilités :",
      `- Continuer : vous n'avez rien à faire. L'abonnement est reconduit pour un an au prix en vigueur (actuellement ${formatEUR(opts.amountCents)} par ${periodWord(opts.billingInterval)}).`,
      `- Arrêter : demandez sa non-reconduction, sans frais ni justification, jusqu'au ${fmtDate(opts.deadline)} (préavis d'un mois), depuis votre espace client ou en répondant à cet e-mail. L'abonnement prendra fin le ${date}.`,
      `- Racheter votre site : il devient le vôtre pour ${formatEUR(opts.buyoutPriceCents!)}, en une fois, sans abonnement ensuite. Répondez à cet e-mail pour le demander : je vous envoie le devis.`,
    ].join("\n");
    content = await templateText(
      "subscription.term_end_buyout",
      { ...common, date_fin: date, bloc_choix: choices, date_limite: callout },
      {
        subject: `Votre abonnement « ${opts.label} » : fin d'engagement le ${date}`,
        body: [salutation, "", `L'engagement de votre abonnement « ${opts.label} » prend fin le ${date}.`, choices, "", callout].join("\n"),
      },
    );
  } else {
    const statement = opts.commitmentEnd
      ? `L'engagement de votre abonnement « ${opts.label} » prend fin le ${date}.`
      : `L'année en cours de votre abonnement « ${opts.label} » prend fin le ${date}.`;
    // Reconduction tacite, date limite de préavis et droit de demander la non-reconduction (bloc fixe).
    const notice = [
      `Sans démarche de votre part, il sera reconduit pour un an au prix en vigueur (actuellement ${formatEUR(opts.amountCents)} par ${periodWord(opts.billingInterval)}).`,
      "",
      callout,
      "",
      "Vous pouvez demander sa non-reconduction, sans frais ni justification, jusqu'à cette date (préavis d'un mois) : depuis votre espace client, ou en répondant à cet e-mail. L'abonnement prendra alors fin le " +
        `${date}.`,
    ].join("\n");
    const objet = opts.commitmentEnd ? `fin d'engagement le ${date}` : `reconduction le ${date}`;
    content = await templateText(
      "subscription.term_end",
      { ...common, objet_echeance: objet, constat_echeance: statement, bloc_echeance: notice },
      { subject: `Votre abonnement « ${opts.label} » : ${objet}`, body: [salutation, "", statement, notice].join("\n") },
    );
  }
  const subject = content.subject;
  const text = [content.body, "", formatPlainTextSignature(opts.settings, opts.brand)].join("\n");
  const html = renderEmailHtml({
    text,
    brand: opts.brand,
    colors: { brandPrimaryColor: opts.settings.brandPrimaryColor, brandSecondaryColor: opts.settings.brandSecondaryColor },
    callout,
    paymentUrl: opts.portalUrl,
    paymentLabel: "Mon espace client",
  });
  return { subject, text, html };
}

/**
 * Rappel avant la date limite de préavis d'un abonnement engagé, quel que soit son rythme de paiement (décision du
 * 23/10/2026) : fin de l'engagement, puis de chaque année reconduite. Envoyé dès 45 jours avant la date limite, dans
 * la fenêtre de l'art. L215-1. Ni pour un abonnement suspendu, ni pour une fin programmée ou demandée. Idempotent par
 * fin de période (renewalReminderSentFor).
 * @returns nombre d'e-mails enfilés.
 */
export async function sendDueTermEndReminders(now: Date = new Date()): Promise<number> {
  if (!(await isSmtpConfigured())) return 0;
  const candidates = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      commitmentEndsAt: { not: null },
      stripeCancelAt: null,
      cancellationRequestedAt: null,
    },
    include: { client: true },
  });
  const due = candidates
    .map((s) => ({ s, term: cancellableTermOf(s.commitmentEndsAt!, now) }))
    .filter(
      ({ s, term }) =>
        term.cancelDeadline.getTime() - now.getTime() <= NOTICE_DAYS_BEFORE_DEADLINE * DAY_MS &&
        s.renewalReminderSentFor?.getTime() !== term.termEndsAt.getTime() &&
        (!s.endDate || s.endDate > term.termEndsAt),
    );
  if (due.length === 0) return 0;

  const settings = await getCompanySettings();
  const brand = buildEmailBrand(settings);
  const portalUrl = await resolveClientPortalUrl();
  // Import tardif : le module du rachat dépend du service d'abonnement, qui dépend de celui-ci.
  const { buyoutOfferPriceCents } = await import("@/lib/subscriptions/buyout.js");
  let queued = 0;
  for (const { s: sub, term } of due) {
    const to = decryptOptional(sub.client.emailEncrypted);
    if (!to) {
      console.warn(`[subscriptions] rappel de fin de période ignoré : client sans e-mail (${sub.id})`);
      continue;
    }
    const commitmentEnd = term.termEndsAt.getTime() === sub.commitmentEndsAt!.getTime();
    // Fin du premier engagement seulement (Q5) : prix de rachat si l'offre en a un et qu'aucun rachat n'est signé.
    const buyoutPriceCents = commitmentEnd ? await buyoutOfferPriceCents(sub.id) : null;
    const content = await renderTermEndReminderEmail({
      brand,
      settings,
      clientName: sub.client.displayName,
      clientFirstName: sub.client.firstName,
      label: sub.label,
      amountCents: sub.amountCents,
      billingInterval: sub.billingInterval,
      termEndsAt: term.termEndsAt,
      deadline: term.cancelDeadline,
      commitmentEnd,
      portalUrl,
      buyoutPriceCents,
    });
    await mailEnqueue({
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      clientId: sub.clientId,
      // Rachat proposé : type à part et abonnement concerné, pour la notification « proposer le rachat ? » (R3).
      kind: buyoutPriceCents != null ? "subscription_term_end_buyout" : "subscription_term_end",
      // Abonnement concerné (tous les avis) : retiré de la file s'il n'a plus d'objet (rachat signé, fin programmée).
      documentId: sub.id,
      bodyTextForMessage: content.text,
    }, { review: { family: "subscription_notice", origin: "WORKER" } });
    await prisma.subscription.update({ where: { id: sub.id }, data: { renewalReminderSentFor: term.termEndsAt } });
    queued += 1;
  }
  return queued;
}

export async function renderFirstChargeNoticeEmail(opts: {
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
  const period = `par ${periodWord(opts.billingInterval)}`;
  const callout = opts.stripe ? `1er prélèvement le ${date}` : `1re facture le ${date}`;
  const salutation = name ? `Bonjour ${name},` : "Bonjour,";
  const objet = callout;
  const intro = `La 1re échéance de votre abonnement « ${opts.label} », de ${formatEUR(opts.amountCents)} ${period}, aura lieu le ${date}.`;
  // Date, montant prélevé ou facturé, et comment gérer ou ne pas poursuivre (bloc fixe).
  const notice = [
    callout,
    "",
    opts.stripe
      ? `Le prélèvement de ${formatEUR(opts.amountCents)} sera fait à cette date sur le moyen de paiement enregistré.`
      : `Une facture de ${formatEUR(opts.amountCents)} vous sera adressée à cette date.`,
    ...(opts.manageUrl
      ? ["Vous pouvez gérer ou résilier votre abonnement depuis son espace de gestion, ou répondre à cet e-mail :", "", opts.manageUrl]
      : ["Pour toute question, ou pour ne pas poursuivre, répondez simplement à cet e-mail."]),
  ].join("\n");
  const content = await templateText(
    "subscription.first_charge",
    {
      salutation,
      prenom: opts.clientFirstName?.trim() ?? "",
      client: opts.clientName,
      abonnement: opts.label,
      montant: formatEUR(opts.amountCents),
      periode: period,
      date_echeance: date,
      objet_echeance: objet,
      bloc_echeance: notice,
    },
    { subject: `Votre abonnement « ${opts.label} » : ${objet}`, body: [salutation, "", intro, "", notice].join("\n") },
  );
  const subject = content.subject;
  const text = [content.body, "", formatPlainTextSignature(opts.settings, opts.brand)].join("\n");
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
 * programmée ou demandée. Idempotent par échéance (firstChargeNoticeSentFor, distinct du marqueur du rappel de fin de période).
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
      s.firstChargeNoticeSentFor?.getTime() !== s.nextInvoiceAt.getTime() &&
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
    const content = await renderFirstChargeNoticeEmail({
      brand,
      settings,
      clientName: sub.client.displayName,
      clientFirstName: sub.client.firstName,
      label: sub.label,
      // 1re échéance remisée (R1) : le montant annoncé est celui qui sera facturé.
      amountCents: nextPeriodAmountCents(sub),
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
      documentId: sub.id,
      bodyTextForMessage: content.text,
    }, { review: { family: "subscription_notice", origin: "WORKER" } });
    await prisma.subscription.update({ where: { id: sub.id }, data: { firstChargeNoticeSentFor: sub.nextInvoiceAt } });
    queued += 1;
  }
  return queued;
}
