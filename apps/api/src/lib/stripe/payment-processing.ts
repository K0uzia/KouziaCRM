import type Stripe from "stripe";
import { prisma } from "@/lib/prisma.js";
import { formatEUR } from "@/lib/money.js";
import { decryptOptional } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { mailEnqueue } from "@/lib/email/mailer/index.js";
import { getStripe } from "@/lib/stripe/client.js";
import { alertAdmin } from "@/lib/stripe/alert.js";

/**
 * Paiements à confirmation différée (prélèvement SEPA : environ 6 jours ouvrés) : l'état « en cours » d'une facture,
 * son échec, le moyen enregistré d'un abonnement et un mandat révoqué. Jamais d'IBAN complet stocké.
 */

/** Facture ERP réglée par ce PaymentIntent : celle du lien, ou celle de l'échéance si elle existe déjà. */
async function invoiceIdOf(pi: Stripe.PaymentIntent): Promise<string | null> {
  const meta = pi.metadata ?? {};
  if (meta.erpInvoiceId) return meta.erpInvoiceId;
  if (!meta.erpMilestoneId) return null;
  const milestone = await prisma.paymentMilestone.findUnique({ where: { id: meta.erpMilestoneId }, select: { invoiceId: true } });
  return milestone?.invoiceId ?? null;
}

function methodOf(pi: Stripe.PaymentIntent): string {
  if (pi.payment_method && typeof pi.payment_method === "object") return pi.payment_method.type;
  return pi.payment_method_types.includes("sepa_debit") ? "sepa_debit" : (pi.payment_method_types[0] ?? "sepa_debit");
}

/** payment_intent.processing : prélèvement lancé, résultat attendu dans quelques jours. */
export async function markInvoiceProcessing(pi: Stripe.PaymentIntent, at = new Date()): Promise<string> {
  const invoiceId = await invoiceIdOf(pi);
  if (!invoiceId) return "ignoré (pas de facture ERP : échéance sans facture)";
  await prisma.invoice.updateMany({
    where: { id: invoiceId, status: "ISSUED" },
    data: { paymentProcessingAt: at, paymentProcessingMethod: methodOf(pi) },
  });
  return "facture en cours de paiement";
}

/** Issue connue (réussite ou échec) : la facture n'est plus « en cours ». */
export async function clearInvoiceProcessing(pi: Stripe.PaymentIntent): Promise<void> {
  const invoiceId = await invoiceIdOf(pi);
  if (invoiceId) await prisma.invoice.updateMany({ where: { id: invoiceId }, data: { paymentProcessingAt: null, paymentProcessingMethod: null } });
}

/**
 * payment_intent.payment_failed d'une facture : elle redevient à régler, l'admin est alerté avec le motif Stripe, le
 * client reçoit un e-mail avec le lien de paiement et le rappel du virement possible.
 */
export async function notifyInvoicePaymentFailed(pi: Stripe.PaymentIntent): Promise<string> {
  const invoiceId = await invoiceIdOf(pi);
  if (!invoiceId) return "ignoré (pas de facture ERP)";
  await clearInvoiceProcessing(pi);
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { client: true } });
  if (!invoice || invoice.status !== "ISSUED") return "ignoré (facture réglée ou annulée)";
  const reason = pi.last_payment_error?.message ?? pi.last_payment_error?.code ?? "motif non communiqué";
  const label = invoice.number ? `la facture ${invoice.number}` : "une facture";
  const method = methodOf(pi) === "sepa_debit" ? "Prélèvement SEPA" : "Paiement en ligne";
  await alertAdmin(
    `${method} refusé : ${invoice.client.displayName}`,
    `${method} refusé pour ${label} (${formatEUR(pi.amount)}) : ${reason}. La facture reste à régler ; le client a reçu le lien et le rappel du virement.`,
  );
  const to = decryptOptional(invoice.client.emailEncrypted);
  if (to) {
    const settings = await getCompanySettings();
    const name = (invoice.client.firstName ?? invoice.client.displayName)?.trim();
    const lines = [
      name ? `Bonjour ${name},` : "Bonjour,",
      "",
      `Le paiement de ${label} (${formatEUR(pi.amount)}) n'a pas abouti.`,
      ...(invoice.checkoutUrl ? ["", `Vous pouvez le régler à nouveau en ligne : ${invoice.checkoutUrl}`] : []),
      ...(settings.bankIban ? ["", `Ou par virement sur l'IBAN ${settings.bankIban}, en indiquant la référence ${invoice.number ?? ""}.`] : []),
      "",
      "Une question ? Répondez simplement à cet e-mail.",
    ];
    await mailEnqueue({
      to,
      subject: `Paiement non abouti : ${invoice.number ?? "facture"}`,
      text: lines.join("\n"),
      clientId: invoice.clientId,
      kind: "payment_failed",
    });
  }
  return "échec signalé";
}

/** Moyen enregistré d'un abonnement Stripe (type et 4 derniers chiffres), pour /suivi. Jamais bloquant. */
export async function recordSubscriptionPaymentMethod(erpSubscriptionId: string, stripeSubscriptionId: string): Promise<void> {
  try {
    const stripe = await getStripe();
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId, { expand: ["default_payment_method"] });
    const pm = sub.default_payment_method;
    if (!pm || typeof pm === "string") return;
    const last4 = pm.type === "sepa_debit" ? pm.sepa_debit?.last4 : pm.type === "card" ? pm.card?.last4 : null;
    await prisma.subscription.update({
      where: { id: erpSubscriptionId },
      data: { paymentMethodType: pm.type, paymentMethodLast4: last4 ?? null },
    });
  } catch (err) {
    console.warn("[stripe] moyen de l'abonnement non relevé", err instanceof Error ? err.message : err);
  }
}

/** mandate.updated : mandat SEPA devenu inactif (révoqué par le client ou sa banque) : alerte admin. */
export async function notifyMandateUpdated(mandate: Stripe.Mandate): Promise<string> {
  if (mandate.status !== "inactive") return `ignoré (mandat ${mandate.status})`;
  await alertAdmin(
    "Mandat de prélèvement SEPA révoqué",
    `Un mandat SEPA (${mandate.id}) est devenu inactif : les prochains prélèvements de ce client échoueront. Envoyez-lui un nouveau lien de mise en place du prélèvement depuis l'abonnement.`,
  );
  return "mandat inactif signalé";
}
