import { SubscriptionCollectionMethod, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { formatEUR } from "@/lib/money.js";
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

function fmtDate(d: Date): string {
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

/** Date limite pour refuser la reconduction : N jours avant le renouvellement (1 = la veille). */
export function nonRenewalDeadline(renewalDate: Date, noticeDays: number): Date {
  return new Date(renewalDate.getTime() - Math.max(0, noticeDays) * DAY_MS);
}

export function renderRenewalReminderEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml" | "brandPrimaryColor">;
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
    colors: { brandPrimaryColor: opts.settings.brandPrimaryColor },
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
      nextInvoiceAt: { gt: now, lte: horizon },
    },
    include: { client: true },
  });

  const due = candidates.filter(
    (s) =>
      s.renewalReminderSentFor?.getTime() !== s.nextInvoiceAt.getTime() &&
      s.nextInvoiceAt.getTime() - s.startDate.getTime() >= MIN_ELAPSED_FOR_RENEWAL_MS &&
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
          ? subscriptionPaymentUrl(sub)
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
