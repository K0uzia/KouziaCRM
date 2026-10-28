import { InvoiceDocumentType, InvoiceStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { getCompanySettings } from "@/lib/company.js";
import { formatEUR, formatLongDate } from "@/lib/money.js";
import { resolveClientPortalUrl } from "@/lib/email/portal-url.js";
import { brandFromSettings, buildEmailContent, renderHtml, type EmailTemplateKind } from "@/lib/email/templates.js";
import { buildEmailBrand, renderDepositCheckoutEmail, renderDepositPaidEmail } from "@/lib/email/deposit-templates.js";
import { templateDefinition, withDraftTemplate } from "@/lib/email/template-registry.js";
import { sendDocumentPdf } from "@/lib/email/send-document-pdf.js";
import { sendPaymentReceipt } from "@/lib/email/payment-receipt.js";
import { portalWelcomeDraft } from "@/lib/clients/access-email.js";
import { onboardingInviteDraft } from "@/lib/clients/onboarding.js";
import { renderClientRenewalEmail } from "@/lib/clients/renewals.js";
import { penaltyClauseText } from "@/lib/reminders/send.js";
import { failedPaymentEmail } from "@/lib/stripe/payment-processing.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";
import { subscriptionSetupContent } from "@/lib/stripe/billing.js";
import {
  renderActionRequiredEmail,
  renderCancelRevokedEmail,
  renderCancelScheduledEmail,
  renderPaymentFailedEmail,
  renderPaymentRecoveredEmail,
  renderSuspendedEmail,
} from "@/lib/subscriptions/dunning.js";
import { nonRenewalDeadline, renderFirstChargeNoticeEmail, renderRenewalReminderEmail, renderTermEndReminderEmail } from "@/lib/subscriptions/renewal-reminder.js";
import { cancelRequestContent, isStripeManaged } from "@/lib/subscriptions/self-service.js";
import { cancellableTermOf } from "@/lib/subscriptions/commitment.js";

/**
 * Aperçu d'un modèle sur une donnée réelle (M3c) : les valeurs sont calculées par le code d'envoi, sur les chemins sans
 * effet de bord (brouillons, rendus), avec le texte saisi à la place du modèle enregistré. Rien n'est envoyé ni écrit.
 * Un lien créé seulement à l'envoi (portail Stripe, page de confirmation de la banque) est remplacé par LINK_AT_SEND.
 */
export const LINK_AT_SEND = "(lien créé à l'envoi)";
const LIMIT = 10;

export type PreviewSource = { id: string; label: string };
type Rendered = { subject: string; text: string; html: string };

const DOCUMENT_KEYS: Record<string, Prisma.InvoiceWhereInput> = {
  "document.quote": { documentType: InvoiceDocumentType.QUOTE },
  "document.invoice": { documentType: InvoiceDocumentType.INVOICE, invoiceType: "SIMPLE" },
  "document.invoice_acompte": { documentType: InvoiceDocumentType.INVOICE, invoiceType: "ACOMPTE" },
  "document.invoice_solde": { documentType: InvoiceDocumentType.INVOICE, invoiceType: "SOLDE" },
  "document.credit_note": { documentType: InvoiceDocumentType.CREDIT_NOTE },
};
const REMINDER_KINDS: Record<string, EmailTemplateKind> = {
  "reminder.soft": "reminder_soft",
  "reminder.firm": "reminder_firm",
  "reminder.formal": "reminder_formal",
};
const SUBSCRIPTION_KEYS = new Set([
  "subscription.setup",
  "subscription.payment_failed",
  "subscription.payment_recovered",
  "subscription.suspended",
  "subscription.action_required",
  "subscription.cancel_scheduled",
  "subscription.cancel_revoked",
  "subscription.cancel_request",
  "subscription.renewal",
  "subscription.term_end",
  "subscription.term_end_buyout",
  "subscription.first_charge",
]);
const ENGAGED_KEYS = new Set(["subscription.term_end", "subscription.term_end_buyout"]);
const NEW_CLIENT = "nouveau";

const day = (d: Date) => formatLongDate(d);

/** Les 10 dernières données du type du modèle ; vide pour un modèle verrouillé ou sans donnée réelle utilisable. */
export async function previewSources(key: string): Promise<PreviewSource[]> {
  const def = templateDefinition(key);
  if (!def || def.locked) return [];
  const documents = DOCUMENT_KEYS[key];
  if (documents) {
    const rows = await prisma.invoice.findMany({
      where: { ...documents, number: { not: null }, client: { emailEncrypted: { not: null } } },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, number: true, client: { select: { displayName: true } } },
    });
    return rows.map((r) => ({ id: r.id, label: `${r.number} - ${r.client.displayName}` }));
  }
  if (REMINDER_KINDS[key]) {
    const rows = await prisma.invoice.findMany({
      where: {
        number: { not: null },
        OR: [{ documentType: InvoiceDocumentType.INVOICE, status: InvoiceStatus.ISSUED }, { documentType: InvoiceDocumentType.QUOTE }],
      },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, number: true, documentType: true, client: { select: { displayName: true } } },
    });
    return rows.map((r) => ({ id: r.id, label: `${r.documentType === InvoiceDocumentType.QUOTE ? "Devis" : "Facture"} ${r.number} - ${r.client.displayName}` }));
  }
  if (key === "payment.receipt") {
    const rows = await prisma.payment.findMany({
      where: { invoice: { documentType: InvoiceDocumentType.INVOICE, number: { not: null }, client: { emailEncrypted: { not: null } } } },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, amountCents: true, paidAt: true, invoice: { select: { number: true, client: { select: { displayName: true } } } } },
    });
    return rows.map((r) => ({ id: r.id, label: `${formatEUR(r.amountCents)} le ${day(r.paidAt)} - ${r.invoice!.number} - ${r.invoice!.client.displayName}` }));
  }
  if (key === "payment.deposit_link" || key === "payment.deposit_paid") {
    const rows = await prisma.paymentMilestone.findMany({
      where: { quote: { number: { not: null } } },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, label: true, quote: { select: { number: true, client: { select: { displayName: true } } } } },
    });
    return rows.map((r) => ({ id: r.id, label: `${r.label} - devis ${r.quote.number} - ${r.quote.client.displayName}` }));
  }
  if (key === "payment.failed") {
    const rows = await prisma.invoice.findMany({
      where: { documentType: InvoiceDocumentType.INVOICE, number: { not: null }, status: InvoiceStatus.ISSUED },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, number: true, client: { select: { displayName: true } } },
    });
    return rows.map((r) => ({ id: r.id, label: `Facture ${r.number} - ${r.client.displayName}` }));
  }
  if (SUBSCRIPTION_KEYS.has(key)) {
    const rows = await prisma.subscription.findMany({
      where: ENGAGED_KEYS.has(key) ? { commitmentEndsAt: { not: null } } : {},
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, label: true, client: { select: { displayName: true } } },
    });
    return rows.map((r) => ({ id: r.id, label: `${r.label} - ${r.client.displayName}` }));
  }
  if (key === "access.welcome") {
    const rows = await prisma.client.findMany({
      where: { emailEncrypted: { not: null } },
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, displayName: true },
    });
    return rows.map((r) => ({ id: r.id, label: r.displayName }));
  }
  if (key === "onboarding.invite") {
    const rows = await prisma.client.findMany({ orderBy: { createdAt: "desc" }, take: LIMIT, select: { id: true, displayName: true } });
    return [{ id: NEW_CLIENT, label: "Nouveau client" }, ...rows.map((r) => ({ id: r.id, label: `${r.displayName} (mise à jour)` }))];
  }
  if (key === "client.renewal") {
    const rows = await prisma.clientRenewal.findMany({
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      select: { id: true, label: true, renewsAt: true, client: { select: { displayName: true } } },
    });
    return rows.map((r) => ({ id: r.id, label: `${r.label} le ${day(r.renewsAt)} - ${r.client.displayName}` }));
  }
  return [];
}

export class PreviewSourceError extends Error {}

/** Rendu du modèle en cours de saisie sur la donnée choisie ; PreviewSourceError si elle n'est pas utilisable. */
export async function previewWithSource(key: string, draft: { subject: string; body: string }, sourceId: string, now = new Date()): Promise<Rendered> {
  const sources = await previewSources(key);
  if (!sources.some((s) => s.id === sourceId)) throw new PreviewSourceError("Donnée introuvable pour ce modèle");
  return withDraftTemplate(key, draft, () => render(key, sourceId, now));
}

async function withHtml(content: { subject: string; text: string }, paymentUrl?: string | null): Promise<Rendered> {
  return { ...content, html: await renderHtml(content.text, await brandFromSettings(), paymentUrl) };
}

async function render(key: string, id: string, now: Date): Promise<Rendered> {
  if (DOCUMENT_KEYS[key]) {
    const result = await sendDocumentPdf(id, { draft: true });
    if (!result.draft) throw new PreviewSourceError("Document sans e-mail client");
    const doc = await prisma.invoice.findUniqueOrThrow({ where: { id }, select: { checkoutUrl: true } });
    return withHtml(result.draft, doc.checkoutUrl);
  }
  const reminderKind = REMINDER_KINDS[key];
  if (reminderKind) {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { client: true } });
    return buildEmailContent({
      kind: reminderKind,
      clientName: invoice.client.displayName,
      clientFirstName: invoice.client.displayName.split(/\s+/)[0],
      docNumber: invoice.number,
      docLabel: invoice.documentType === InvoiceDocumentType.QUOTE ? "devis" : "facture",
      brand: await brandFromSettings(),
      ...(reminderKind === "reminder_formal" ? { penaltyText: await penaltyClauseText(invoice.client.type) } : {}),
    });
  }
  if (key === "payment.receipt") {
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id }, select: { invoiceId: true, amountCents: true } });
    const result = await sendPaymentReceipt(payment.invoiceId!, payment.amountCents, id, { draft: true });
    if (!result.draft) throw new PreviewSourceError("Facture sans e-mail client");
    return withHtml(result.draft);
  }
  if (key === "payment.deposit_link" || key === "payment.deposit_paid") {
    const milestone = await prisma.paymentMilestone.findUniqueOrThrow({ where: { id }, include: { quote: { include: { client: true } } } });
    const settings = await getCompanySettings();
    const depositTotal = (await prisma.paymentMilestone.count({ where: { quoteId: milestone.quoteId } })) || 2;
    const common = {
      brand: buildEmailBrand(settings),
      settings,
      clientFirstName: milestone.quote.client.firstName,
      clientName: milestone.quote.client.displayName,
      quoteNumber: milestone.quote.number ?? "",
      amountCents: milestone.amountCents,
      depositIndex: milestone.position,
      depositTotal,
      label: milestone.label,
    };
    if (key === "payment.deposit_paid") return withHtml(await renderDepositPaidEmail(common));
    return renderDepositCheckoutEmail({ ...common, brandPrimaryColor: settings.brandPrimaryColor, checkoutUrl: milestone.checkoutUrl ?? LINK_AT_SEND });
  }
  if (key === "payment.failed") {
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id }, include: { client: true } });
    const label = `la facture ${invoice.number}`;
    return withHtml(
      await failedPaymentEmail({
        name: (invoice.client.firstName ?? invoice.client.displayName)?.trim(),
        reference: invoice.number ?? "facture",
        paiement: `Le paiement de ${label}`,
        amountCents: invoice.totalCents,
        checkoutUrl: invoice.checkoutUrl,
        ibanReference: invoice.number ?? "",
      }),
    );
  }
  if (SUBSCRIPTION_KEYS.has(key)) return renderSubscription(key, id, now);
  if (key === "access.welcome") {
    const draft = await portalWelcomeDraft(id);
    if (!draft) throw new PreviewSourceError("Client sans e-mail");
    return withHtml(draft);
  }
  if (key === "onboarding.invite") return withHtml(await onboardingInviteDraft("", id === NEW_CLIENT ? null : id));
  if (key === "client.renewal") {
    const renewal = await prisma.clientRenewal.findUniqueOrThrow({ where: { id }, include: { client: true } });
    const settings = await getCompanySettings();
    return renderClientRenewalEmail({ brand: buildEmailBrand(settings), settings, clientName: renewal.client.displayName, clientFirstName: renewal.client.firstName, renewal });
  }
  throw new PreviewSourceError("Aperçu sur donnée réelle indisponible pour ce modèle");
}

async function renderSubscription(key: string, id: string, now: Date): Promise<Rendered> {
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { id }, include: { client: true } });
  const settings = await getCompanySettings();
  const ctx = { brand: buildEmailBrand(settings), settings, clientName: sub.client.displayName, clientFirstName: sub.client.firstName };
  const stripe = isStripeManaged(sub);
  // Abonnement prélevé par Stripe : son lien de gestion se crée à l'envoi ; sinon, le lien de mise en place (signé, sans écriture).
  const manageUrl = stripe ? LINK_AT_SEND : buildPayUrl("subscribe", sub.id);
  const lastInvoice = sub.lastInvoiceId ? await prisma.invoice.findUnique({ where: { id: sub.lastInvoiceId }, select: { number: true } }) : null;
  const invoiceNumber = lastInvoice?.number ?? null;
  switch (key) {
    case "subscription.setup":
      return subscriptionSetupContent(sub);
    case "subscription.payment_failed":
      return renderPaymentFailedEmail({ ...ctx, label: sub.label, amountCents: sub.amountCents, invoiceNumber, nextAttempt: null, url: manageUrl });
    case "subscription.payment_recovered":
      return renderPaymentRecoveredEmail({ ...ctx, label: sub.label, amountCents: sub.amountCents, invoiceNumber });
    case "subscription.suspended":
      return renderSuspendedEmail({ ...ctx, label: sub.label, url: manageUrl });
    case "subscription.action_required":
      return renderActionRequiredEmail({ ...ctx, label: sub.label, amountCents: sub.amountCents, invoiceNumber, url: LINK_AT_SEND, reminder: false });
    case "subscription.cancel_scheduled": {
      const endsAt = sub.stripeCancelAt ?? sub.endDate ?? (sub.commitmentEndsAt ? cancellableTermOf(sub.commitmentEndsAt, now).termEndsAt : sub.nextInvoiceAt);
      return renderCancelScheduledEmail({ ...ctx, label: sub.label, endsAt });
    }
    case "subscription.cancel_revoked":
      return renderCancelRevokedEmail({ ...ctx, label: sub.label });
    case "subscription.cancel_request":
      return cancelRequestContent(sub, now);
    case "subscription.renewal":
      return renderRenewalReminderEmail({
        ...ctx,
        label: sub.label,
        amountCents: sub.amountCents,
        renewalDate: sub.nextInvoiceAt,
        deadline: nonRenewalDeadline(sub.nextInvoiceAt, settings.nonRenewalNoticeDays),
        manageUrl: stripe ? LINK_AT_SEND : null,
      });
    case "subscription.term_end":
    case "subscription.term_end_buyout": {
      const term = cancellableTermOf(sub.commitmentEndsAt!, now);
      const commitmentEnd = term.termEndsAt.getTime() === sub.commitmentEndsAt!.getTime();
      let buyoutPriceCents: number | null = null;
      if (key === "subscription.term_end_buyout") {
        const { buyoutOfferPriceCents } = await import("@/lib/subscriptions/buyout.js");
        buyoutPriceCents = commitmentEnd ? await buyoutOfferPriceCents(sub.id) : null;
        if (buyoutPriceCents == null) throw new PreviewSourceError("Pas de rachat proposé pour cet abonnement à cette date");
      }
      return renderTermEndReminderEmail({
        ...ctx,
        label: sub.label,
        amountCents: sub.amountCents,
        billingInterval: sub.billingInterval,
        termEndsAt: term.termEndsAt,
        deadline: term.cancelDeadline,
        commitmentEnd,
        portalUrl: await resolveClientPortalUrl(),
        buyoutPriceCents,
      });
    }
    case "subscription.first_charge":
      return renderFirstChargeNoticeEmail({
        ...ctx,
        label: sub.label,
        amountCents: sub.amountCents,
        billingInterval: sub.billingInterval,
        firstChargeDate: sub.nextInvoiceAt,
        manageUrl: stripe ? LINK_AT_SEND : null,
        stripe,
      });
  }
  throw new PreviewSourceError("Aperçu sur donnée réelle indisponible pour ce modèle");
}
