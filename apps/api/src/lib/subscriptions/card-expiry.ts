import type { CompanySettings } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { decryptOptional } from "@/lib/crypto.js";
import { isSmtpConfigured } from "@/lib/email/smtp.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { buildEmailBrand } from "@/lib/email/deposit-templates.js";
import { renderEmailHtml } from "@/lib/email/layout.js";
import { formatPlainTextSignature } from "@/lib/email/signature.js";
import type { EmailBrand } from "@/lib/email/templates.js";
import { getStripe } from "@/lib/stripe/client.js";
import { subscriptionCardUpdateUrl } from "@/lib/stripe/portal.js";

const DAY_MS = 86_400_000;
/** Chaque abonnement est vérifié une fois par mois. */
const CHECK_EVERY_MS = 30 * DAY_MS;
/** Appels Stripe par passage du worker (horaire) : la vérification mensuelle s'étale. */
const BATCH = 20;

/** Premier jour du mois qui suit l'expiration : la carte n'est plus valable à cette date. */
export function cardExpiresAt(expMonth: number, expYear: number): Date {
  return new Date(expYear, expMonth, 1);
}

/** Carte à signaler : invalide avant la prochaine échéance, ou dans le mois qui vient. */
export function cardNeedsNotice(expiresAt: Date, nextInvoiceAt: Date, now: Date): boolean {
  return expiresAt <= nextInvoiceAt || expiresAt.getTime() <= now.getTime() + 31 * DAY_MS;
}

export function renderCardExpiryEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml" | "brandPrimaryColor" | "brandSecondaryColor">;
  clientName: string;
  clientFirstName?: string | null;
  label: string;
  cardBrand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  url: string;
}) {
  const name = (opts.clientFirstName ?? opts.clientName)?.trim();
  const expiry = `${String(opts.expMonth).padStart(2, "0")}/${opts.expYear}`;
  const card = `${opts.cardBrand.toUpperCase()} se terminant par ${opts.last4}`;
  const text = [
    name ? `Bonjour ${name},` : "Bonjour,",
    "",
    `La carte ${card}, utilisée pour votre abonnement « ${opts.label} », expire fin ${expiry}.`,
    "",
    "Pour que les prochains prélèvements passent sans interruption, mettez-la à jour :",
    "",
    opts.url,
    "",
    "Une question ? Répondez simplement à cet e-mail.",
    "",
    formatPlainTextSignature(opts.settings, opts.brand),
  ].join("\n");
  const html = renderEmailHtml({
    text,
    brand: opts.brand,
    colors: { brandPrimaryColor: opts.settings.brandPrimaryColor, brandSecondaryColor: opts.settings.brandSecondaryColor },
    paymentUrl: opts.url,
    paymentLabel: "Mettre à jour ma carte",
  });
  return { subject: `Votre carte expire bientôt : ${opts.label}`, text, html };
}

function defaultCard(stripeSub: Stripe.Subscription): Stripe.PaymentMethod | null {
  const own = stripeSub.default_payment_method;
  if (own && typeof own !== "string") return own;
  const customer = stripeSub.customer;
  if (customer && typeof customer !== "string" && !customer.deleted) {
    const pm = customer.invoice_settings?.default_payment_method;
    if (pm && typeof pm !== "string") return pm;
  }
  return null;
}

/**
 * Vérification mensuelle de la carte par défaut des abonnements Stripe actifs. Un e-mail par carte
 * et par date d'expiration (cardExpiryNoticeFor), même si plusieurs abonnements du client la
 * partagent, avec le lien de changement de carte. Le
 * prélèvement SEPA n'expire pas : non concerné.
 * @returns nombre d'e-mails enfilés.
 */
export async function checkExpiringCards(now: Date = new Date()): Promise<number> {
  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled || !settings.stripeSecretKeyEncrypted) return 0;
  if (!(await isSmtpConfigured())) return 0;

  const subs = await prisma.subscription.findMany({
    where: {
      status: "ACTIVE",
      collectionMethod: "STRIPE",
      stripeSubscriptionId: { not: null },
      stripeCancelAt: null,
      OR: [{ cardCheckedAt: null }, { cardCheckedAt: { lt: new Date(now.getTime() - CHECK_EVERY_MS) } }],
    },
    include: { client: true },
    orderBy: { cardCheckedAt: { sort: "asc", nulls: "first" } },
    take: BATCH,
  });
  if (subs.length === 0) return 0;

  const stripe = await getStripe();
  const brand = buildEmailBrand(settings);
  let queued = 0;
  for (const sub of subs) {
    await prisma.subscription.update({ where: { id: sub.id }, data: { cardCheckedAt: now } });
    try {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId!, {
        expand: ["default_payment_method", "customer.invoice_settings.default_payment_method"],
      });
      const pm = defaultCard(stripeSub);
      if (pm?.type !== "card" || !pm.card) continue;
      const { exp_month: expMonth, exp_year: expYear, last4, brand: cardBrand } = pm.card;
      if (!cardNeedsNotice(cardExpiresAt(expMonth, expYear), sub.nextInvoiceAt, now)) continue;
      const key = `${pm.id}:${expYear}-${String(expMonth).padStart(2, "0")}`;
      if (sub.cardExpiryNoticeFor === key) continue;
      // Carte partagée par plusieurs abonnements : déjà signalée pour l'un d'eux, on note sans renvoyer.
      const alreadyNotified = await prisma.subscription.count({ where: { clientId: sub.clientId, cardExpiryNoticeFor: key } });
      if (alreadyNotified > 0) {
        await prisma.subscription.update({ where: { id: sub.id }, data: { cardExpiryNoticeFor: key } });
        continue;
      }

      const to = decryptOptional(sub.client.emailEncrypted);
      if (!to) {
        console.warn(`[subscriptions] avis de carte expirée ignoré : client sans e-mail (${sub.id})`);
        continue;
      }
      const content = renderCardExpiryEmail({
        brand,
        settings,
        clientName: sub.client.displayName,
        clientFirstName: sub.client.firstName,
        label: sub.label,
        cardBrand,
        last4,
        expMonth,
        expYear,
        url: await subscriptionCardUpdateUrl(sub),
      });
      await mailEnqueue({
        to,
        subject: content.subject,
        text: content.text,
        html: content.html,
        clientId: sub.clientId,
        kind: "subscription_card_expiring",
        bodyTextForMessage: content.text,
      }, { review: { family: "payment_issue", origin: "WORKER" } });
      await prisma.subscription.update({ where: { id: sub.id }, data: { cardExpiryNoticeFor: key } });
      queued += 1;
    } catch (err) {
      console.error(`[subscriptions] vérification de carte échouée pour ${sub.id}`, err);
    }
  }
  return queued;
}
