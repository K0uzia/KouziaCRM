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

export const RENEWAL_REMINDER_DAYS = 30;
const DAY_MS = 86_400_000;
/** En deçà, l'échéance est la 1re facture de l'abonnement, pas un renouvellement. */
const MIN_ELAPSED_FOR_RENEWAL_MS = 300 * DAY_MS;

function fmtDate(d: Date): string {
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

export function renderRenewalReminderEmail(opts: {
  brand: EmailBrand;
  settings: Pick<CompanySettings, "emailSignatureHtml" | "brandPrimaryColor">;
  clientName: string;
  clientFirstName?: string | null;
  label: string;
  amountCents: number;
  renewalDate: Date;
}) {
  const name = (opts.clientFirstName ?? opts.clientName)?.trim();
  const date = fmtDate(opts.renewalDate);
  const subject = `Renouvellement de votre abonnement annuel le ${date}`;
  const text = [
    name ? `Bonjour ${name},` : "Bonjour,",
    "",
    `Votre abonnement annuel « ${opts.label} » sera renouvelé le ${date}.`,
    `Une facture de ${formatEUR(opts.amountCents)} vous sera adressée à cette date.`,
    "",
    "Si vous ne souhaitez pas le renouveler, il vous suffit de répondre à cet e-mail avant cette date.",
    "",
    formatPlainTextSignature(opts.settings, opts.brand),
  ].join("\n");
  const html = renderEmailHtml({
    text,
    brand: opts.brand,
    colors: { brandPrimaryColor: opts.settings.brandPrimaryColor },
  });
  return { subject, text, html };
}

/**
 * Rappel J-30 avant le renouvellement d'un abonnement annuel facturé par l'ERP.
 * Un prélèvement Stripe est exclu : Stripe émet ses factures et ses propres rappels.
 * Idempotent par échéance (renewalReminderSentFor).
 * @returns nombre de rappels enfilés.
 */
export async function sendDueRenewalReminders(now: Date = new Date()): Promise<number> {
  if (!(await isSmtpConfigured())) return 0;

  const horizon = new Date(now.getTime() + RENEWAL_REMINDER_DAYS * DAY_MS);
  const candidates = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      billingInterval: "YEAR",
      collectionMethod: { not: SubscriptionCollectionMethod.STRIPE },
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

  const settings = await getCompanySettings();
  const brand = buildEmailBrand(settings);
  let queued = 0;
  for (const sub of due) {
    const to = decryptOptional(sub.client.emailEncrypted);
    if (!to) {
      console.warn(`[subscriptions] rappel de renouvellement ignoré : client sans e-mail (${sub.id})`);
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
