import type { CompanySettings } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import type { EmailOrigin } from "@/lib/email/review.js";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { formatEUR, formatLongDate } from "@/lib/money.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import type { EmailBrand } from "@/lib/email/templates.js";
import { alertAdmin } from "@/lib/stripe/alert.js";
import { getStripe } from "@/lib/stripe/client.js";
import { issueErpInvoiceFromStripeInvoice, type StripeSyncResult } from "@/lib/stripe/billing.js";
import { subscriptionPaymentUrl } from "@/lib/stripe/portal.js";

/**
 * E-mails client des abonnements prélevés par Stripe, déclenchés par les événements Stripe :
 * échec, régularisation, confirmation de paiement (3DS, avec rappels J+3, J+5, J+7), suspension
 * faute de paiement, résiliation programmée ou annulée. Stripe reste seul à envoyer les avis de
 * prélèvement SEPA.
 */

const fmtDate = formatLongDate;

type MailContext = {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml" | "brandPrimaryColor" | "brandSecondaryColor">;
  clientName: string;
  clientFirstName?: string | null;
};

function greeting(ctx: MailContext): string {
  const name = (ctx.clientFirstName ?? ctx.clientName)?.trim();
  return name ? `Bonjour ${name},` : "Bonjour,";
}

function finish(ctx: MailContext, subject: string, body: string[], button?: { url: string; label: string }) {
  const text = [greeting(ctx), "", ...body, "", formatPlainTextSignature(ctx.settings, ctx.brand)].join("\n");
  const html = renderEmailHtml({
    text,
    brand: ctx.brand,
    colors: { brandPrimaryColor: ctx.settings.brandPrimaryColor, brandSecondaryColor: ctx.settings.brandSecondaryColor },
    paymentUrl: button?.url,
    paymentLabel: button?.label,
  });
  return { subject, text, html };
}

const QUESTION = "Une question ? Répondez simplement à cet e-mail.";

export function renderPaymentFailedEmail(
  ctx: MailContext & {
    label: string;
    amountCents: number;
    invoiceNumber: string | null;
    nextAttempt: Date | null;
    url: string;
  },
) {
  const invoice = ctx.invoiceNumber ? ` (facture ${ctx.invoiceNumber})` : "";
  // Sans nouvelle tentative prévue (cas par défaut d'un prélèvement SEPA), rien n'est promis.
  const next = ctx.nextAttempt
    ? [
        `Une nouvelle tentative aura lieu le ${fmtDate(ctx.nextAttempt)}. Si votre moyen de paiement a changé, mettez-le à jour avant cette date :`,
      ]
    : ["Aucune nouvelle tentative automatique n'est prévue. Pour régulariser, réglez l'échéance ou changez de moyen de paiement :"];
  return finish(
    ctx,
    `Prélèvement non abouti : ${ctx.label}`,
    [
      `Le prélèvement de ${formatEUR(ctx.amountCents)} pour votre abonnement « ${ctx.label} »${invoice} n'a pas abouti.`,
      "",
      ...next,
      "",
      ctx.url,
      "",
      QUESTION,
    ],
    { url: ctx.url, label: ctx.nextAttempt ? "Mettre à jour mon moyen de paiement" : "Régulariser le paiement" },
  );
}

export function renderPaymentRecoveredEmail(
  ctx: MailContext & { label: string; amountCents: number; invoiceNumber: string | null },
) {
  const invoice = ctx.invoiceNumber ? ` (facture ${ctx.invoiceNumber})` : "";
  return finish(ctx, `Paiement reçu, merci : ${ctx.label}`, [
    `Le paiement de ${formatEUR(ctx.amountCents)} pour votre abonnement « ${ctx.label} »${invoice} est bien arrivé : la situation est régularisée.`,
    "",
    "Votre abonnement continue normalement. Merci !",
  ]);
}

export function renderSuspendedEmail(ctx: MailContext & { label: string; url: string }) {
  return finish(
    ctx,
    `Abonnement suspendu faute de paiement : ${ctx.label}`,
    [
      `Malgré les tentatives de prélèvement, une échéance de votre abonnement « ${ctx.label} » reste impayée. L'abonnement est suspendu jusqu'à son règlement.`,
      "",
      "Pour régulariser, réglez l'échéance ou changez de moyen de paiement :",
      "",
      ctx.url,
      "",
      QUESTION,
    ],
    { url: ctx.url, label: "Régulariser le paiement" },
  );
}

export function renderCancelScheduledEmail(ctx: MailContext & { label: string; endsAt: Date }) {
  const date = fmtDate(ctx.endsAt);
  return finish(ctx, `Résiliation enregistrée : ${ctx.label}`, [
    `Nous avons bien enregistré la résiliation de votre abonnement « ${ctx.label} ».`,
    "",
    `Il prendra fin le ${date} : aucun prélèvement ne sera fait après cette date.`,
    "",
    "Cet e-mail vaut accusé de réception de votre demande. Conservez-le.",
    "",
    QUESTION,
  ]);
}

export function renderCancelRevokedEmail(ctx: MailContext & { label: string }) {
  return finish(ctx, `Résiliation annulée : ${ctx.label}`, [
    `La résiliation de votre abonnement « ${ctx.label} » a été annulée : il continue normalement.`,
    "",
    QUESTION,
  ]);
}

async function mailContext(clientId: string) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
  const settings = await getCompanySettings();
  return {
    to: decryptOptional(client.emailEncrypted),
    ctx: {
      brand: buildEmailBrand(settings),
      settings,
      clientName: client.displayName,
      clientFirstName: client.firstName,
    } satisfies MailContext,
  };
}

async function send(
  clientId: string,
  kind: string,
  build: (ctx: MailContext) => { subject: string; text: string; html: string },
  documentId?: string,
): Promise<boolean> {
  const { to, ctx } = await mailContext(clientId);
  if (!to) {
    console.warn(`[subscriptions] e-mail ${kind} non envoyé : client sans e-mail (${clientId})`);
    return false;
  }
  const content = build(ctx);
  await mailEnqueue({
    to,
    subject: content.subject,
    text: content.text,
    html: content.html,
    clientId,
    documentId,
    kind,
    bodyTextForMessage: content.text,
  }, { review: { family: "payment_issue", origin: (kind === "subscription_action_reminder" ? "WORKER" : "WEBHOOK") satisfies EmailOrigin } });
  return true;
}

/**
 * invoice.payment_failed : un e-mail par facture et par tentative (attempt_count), alerte admin.
 * La facture ERP miroir est créée si invoice.finalized n'est pas encore arrivé.
 */
export async function handleStripePaymentFailed(stripeInvoice: Stripe.Invoice): Promise<string> {
  if (!stripeInvoice.id) return "sans identifiant";
  const { invoiceId } = await issueErpInvoiceFromStripeInvoice(stripeInvoice);
  const attempt = Math.max(1, stripeInvoice.attempt_count ?? 1);
  // Réservation atomique : deux livraisons du même échec n'envoient qu'un e-mail.
  const claimed = await prisma.invoice.updateMany({
    where: {
      id: invoiceId,
      OR: [{ stripeFailureNotifiedAttempt: null }, { stripeFailureNotifiedAttempt: { lt: attempt } }],
    },
    data: { stripeFailureNotifiedAttempt: attempt },
  });
  if (claimed.count === 0) return "échec déjà signalé";

  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { subscription: true } });
  const sub = invoice.subscription;
  const nextAttempt = stripeInvoice.next_payment_attempt ? new Date(stripeInvoice.next_payment_attempt * 1000) : null;
  const amountCents = stripeInvoice.amount_due ?? invoice.totalCents;

  await alertAdmin(
    `Échec de prélèvement Stripe : ${invoice.number ?? stripeInvoice.id}`,
    `Le prélèvement de ${formatEUR(amountCents)} (facture ${invoice.number ?? stripeInvoice.id}, tentative ${attempt}) a échoué. ` +
      (nextAttempt
        ? `Stripe retentera le ${fmtDate(nextAttempt)}.`
        : "Aucune nouvelle tentative automatique n'est prévue.") +
      " Le client a reçu un e-mail avec le lien pour régulariser.",
  );
  if (!sub) return "échec signalé (sans abonnement ERP)";
  // Paiement en attente de confirmation (3DS) : le client a déjà l'e-mail « confirmer le paiement ».
  if (invoice.stripeActionRequiredAt) return `échec signalé à l'admin (tentative ${attempt}, confirmation déjà demandée)`;
  const url = await subscriptionPaymentUrl(sub);
  await send(
    invoice.clientId,
    "subscription_payment_failed",
    (ctx) =>
      renderPaymentFailedEmail({
        ...ctx,
        label: sub.label,
        amountCents,
        invoiceNumber: invoice.number,
        nextAttempt,
        url,
      }),
    invoice.id,
  );
  return `échec signalé (tentative ${attempt})`;
}

export function renderActionRequiredEmail(
  ctx: MailContext & { label: string; amountCents: number; invoiceNumber: string | null; url: string; reminder: boolean },
) {
  const invoice = ctx.invoiceNumber ? ` (facture ${ctx.invoiceNumber})` : "";
  return finish(
    ctx,
    `${ctx.reminder ? "Rappel : confirmation" : "Confirmation"} de paiement requise : ${ctx.label}`,
    [
      `Votre banque demande de confirmer le paiement de ${formatEUR(ctx.amountCents)} pour votre abonnement « ${ctx.label} »${invoice}.`,
      "",
      "Le paiement ne sera fait qu'après votre confirmation, sur la page sécurisée de Stripe :",
      "",
      ctx.url,
      "",
      QUESTION,
    ],
    { url: ctx.url, label: "Confirmer le paiement" },
  );
}

/** Délais des rappels de confirmation après la demande : J+3, J+5, J+7. */
export const ACTION_REMINDER_DAYS = [3, 5, 7] as const;

/** invoice.payment_action_required (3DS) : un e-mail par facture avec la page Stripe de confirmation. */
export async function handleStripeActionRequired(stripeInvoice: Stripe.Invoice): Promise<string> {
  if (!stripeInvoice.id || !stripeInvoice.hosted_invoice_url) return "sans page de facture";
  const { invoiceId } = await issueErpInvoiceFromStripeInvoice(stripeInvoice);
  const claimed = await prisma.invoice.updateMany({
    where: { id: invoiceId, stripeActionRequiredAt: null },
    data: { stripeActionRequiredAt: new Date(), stripeActionUrl: stripeInvoice.hosted_invoice_url },
  });
  if (claimed.count === 0) return "confirmation déjà demandée";
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { subscription: true } });
  const url = stripeInvoice.hosted_invoice_url;
  await send(
    invoice.clientId,
    "subscription_action_required",
    (ctx) =>
      renderActionRequiredEmail({
        ...ctx,
        label: invoice.subscription?.label ?? invoice.number ?? "abonnement",
        amountCents: stripeInvoice.amount_due ?? invoice.totalCents,
        invoiceNumber: invoice.number,
        url,
        reminder: false,
      }),
    invoice.id,
  );
  return "confirmation demandée";
}

/**
 * Rappels de confirmation (J+3, J+5, J+7) tant que la facture n'est pas payée. L'état est relu chez
 * Stripe avant chaque rappel : une facture payée, annulée ou non recouvrable n'en reçoit plus.
 * @returns nombre de rappels enfilés.
 */
export async function sendDueActionReminders(now: Date = new Date()): Promise<number> {
  if (!(await isSmtpConfigured())) return 0;
  const pending = await prisma.invoice.findMany({
    where: {
      stripeActionRequiredAt: { not: null },
      stripeActionReminderCount: { lt: ACTION_REMINDER_DAYS.length },
      status: "ISSUED",
      stripeInvoiceId: { not: null },
      stripeUncollectibleAt: null,
    },
    include: { subscription: true },
  });
  let queued = 0;
  for (const invoice of pending) {
    const count = invoice.stripeActionReminderCount;
    const dueAt = invoice.stripeActionRequiredAt!.getTime() + ACTION_REMINDER_DAYS[count]! * 86_400_000;
    if (now.getTime() < dueAt) continue;
    const claimed = await prisma.invoice.updateMany({
      where: { id: invoice.id, stripeActionReminderCount: count },
      data: { stripeActionReminderCount: count + 1 },
    });
    if (claimed.count === 0) continue;
    try {
      const stripe = await getStripe();
      const current = await stripe.invoices.retrieve(invoice.stripeInvoiceId!);
      if (current.status !== "open") {
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { stripeActionReminderCount: ACTION_REMINDER_DAYS.length },
        });
        continue;
      }
      const url = current.hosted_invoice_url ?? invoice.stripeActionUrl;
      if (!url) continue;
      const sent = await send(
        invoice.clientId,
        "subscription_action_reminder",
        (ctx) =>
          renderActionRequiredEmail({
            ...ctx,
            label: invoice.subscription?.label ?? invoice.number ?? "abonnement",
            amountCents: current.amount_due ?? invoice.totalCents,
            invoiceNumber: invoice.number,
            url,
            reminder: true,
          }),
        invoice.id,
      );
      if (sent) queued += 1;
    } catch (err) {
      console.error(`[subscriptions] rappel de confirmation échoué pour ${invoice.id}`, err);
    }
  }
  return queued;
}

/** Après invoice.paid : e-mail de régularisation si un échec avait été signalé pour cette facture. */
export async function notifyStripePaymentRecovered(erpInvoiceId: string): Promise<boolean> {
  const claimed = await prisma.invoice.updateMany({
    where: { id: erpInvoiceId, stripeFailureNotifiedAttempt: { not: null }, stripeRecoveryNotifiedAt: null },
    data: { stripeRecoveryNotifiedAt: new Date() },
  });
  if (claimed.count === 0) return false;
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: erpInvoiceId },
    include: { subscription: true, payments: true },
  });
  const label = invoice.subscription?.label ?? invoice.number ?? "abonnement";
  const amountCents = invoice.payments.reduce((s, p) => s + p.amountCents, 0) || invoice.totalCents;
  await alertAdmin(
    `Prélèvement régularisé : ${invoice.number ?? erpInvoiceId}`,
    `La facture ${invoice.number ?? erpInvoiceId} (${formatEUR(amountCents)}) a été réglée après un échec. Le client a reçu un e-mail de remerciement.`,
  );
  return send(
    invoice.clientId,
    "subscription_payment_recovered",
    (ctx) => renderPaymentRecoveredEmail({ ...ctx, label, amountCents, invoiceNumber: invoice.number }),
    invoice.id,
  );
}

/** invoice.marked_uncollectible : la facture ERP reste émise et impayée (ni annulation ni avoir), sans relance. */
export async function handleStripeInvoiceUncollectible(stripeInvoice: Stripe.Invoice): Promise<string> {
  if (!stripeInvoice.id) return "sans identifiant";
  const invoice = await prisma.invoice.findUnique({ where: { stripeInvoiceId: stripeInvoice.id } });
  if (!invoice) return "aucune facture ERP";
  if (invoice.stripeUncollectibleAt) return "déjà noté";
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { stripeUncollectibleAt: new Date(), nextReminderAt: null },
  });
  await alertAdmin(
    `Facture non recouvrable dans Stripe : ${invoice.number ?? stripeInvoice.id}`,
    `La facture ${invoice.number ?? stripeInvoice.id} (${formatEUR(invoice.totalCents)}) a été marquée non recouvrable dans Stripe. ` +
      "Dans l'ERP, elle reste émise et impayée (ni annulation ni avoir). À traiter avec le client.",
  );
  return "non recouvrable noté";
}

/** Suites client et admin d'une synchronisation d'abonnement Stripe. */
export async function notifySubscriptionSync(result: StripeSyncResult): Promise<void> {
  const sub = await prisma.subscription.findUnique({ where: { id: result.subscriptionId }, include: { client: true } });
  if (!sub) return;
  const who = sub.client.displayName;

  if (result.change) {
    const c = result.change;
    const state = c.to === "ENDED" ? "clôturé" : c.to === "PAUSED" ? "suspendu" : "repris";
    await alertAdmin(
      `Abonnement ${state} depuis Stripe : ${c.clientName}`,
      `L'abonnement « ${c.label} » de ${c.clientName} est passé à « ${state} » dans l'ERP (${c.reason}). Aucune action n'a été faite depuis l'ERP : vérifiez la situation avec le client.`,
    );
  }
  if (result.becameUnpaid) {
    const url = await subscriptionPaymentUrl(sub);
    await send(sub.clientId, "subscription_suspended", (ctx) => renderSuspendedEmail({ ...ctx, label: sub.label, url }));
  }
  if (result.cancelScheduledAt) {
    const endsAt = result.cancelScheduledAt;
    await alertAdmin(
      `Résiliation programmée : ${who}`,
      `L'abonnement « ${sub.label} » de ${who} prendra fin le ${fmtDate(endsAt)} (résiliation faite dans Stripe ou le portail client). Le client a reçu un accusé par e-mail.`,
    );
    await send(sub.clientId, "subscription_cancel_scheduled", (ctx) =>
      renderCancelScheduledEmail({ ...ctx, label: sub.label, endsAt }),
    );
  }
  if (result.cancelRevoked) {
    await alertAdmin(
      `Résiliation annulée : ${who}`,
      `La résiliation programmée de l'abonnement « ${sub.label} » de ${who} a été annulée : il continue.`,
    );
    await send(sub.clientId, "subscription_cancel_revoked", (ctx) => renderCancelRevokedEmail({ ...ctx, label: sub.label }));
  }
}
