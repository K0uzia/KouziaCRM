import { subscriptionMethodTypes } from "@/lib/stripe/payment-methods.js";
import { nextPeriodAmountCents } from "@/lib/quotes/recurring-discount-calc.js";
import { BALANCE_INCLUDE, invoiceBalance } from "@/lib/invoices/balance.js";
import { prisma } from "@/lib/prisma.js";
import { periodWord } from "@/lib/subscriptions/subscription-service.js";
import { formatEUR } from "@/lib/money.js";
import type { PayTokenKind } from "@/lib/stripe/pay-token.js";
import { getCompanySettings } from "@/lib/company.js";
import { belowOnlineMinimum, onlineMinimumMessage } from "@/lib/stripe/minimum.js";

/**
 * Page intermédiaire d'un lien de paiement : le GET n'a aucun effet (les antivirus de messagerie
 * préchargent les liens) ; le bouton envoie un POST qui crée la session Checkout.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** button null : pas de paiement en ligne possible, notice explique quoi faire. */
export type PayPageInfo = {
  title: string;
  detail: string;
  button: string | null;
  notice?: string;
  /** Titre de l'onglet (défaut : « Paiement Kouzia »). */
  pageTitle?: string;
} | null;

/** Sous le minimum Stripe : page sans bouton, avec le message et le contact. */
async function withMinimum(info: NonNullable<PayPageInfo>, amountCents: number): Promise<NonNullable<PayPageInfo>> {
  if (!belowOnlineMinimum(amountCents)) return info;
  const settings = await getCompanySettings();
  return { ...info, button: null, notice: onlineMinimumMessage(settings.email) };
}

/** Prélèvement SEPA lancé, résultat attendu : un second paiement ferait payer deux fois (audit du 25/10/2026). */
export const PROCESSING_NOTICE =
  "Un prélèvement est déjà en cours pour ce paiement : son résultat arrive sous quelques jours ouvrés. Aucun autre paiement n'est nécessaire.";

const processing = (info: NonNullable<PayPageInfo>): NonNullable<PayPageInfo> => ({ ...info, button: null, notice: PROCESSING_NOTICE });

/** Libellé et montant affichés avant le paiement ; null si le document n'est plus payable. */
export async function payPageInfo(kind: PayTokenKind, id: string): Promise<PayPageInfo> {
  if (kind === "invoice") {
    const inv = await prisma.invoice.findUnique({ where: { id }, include: BALANCE_INCLUDE });
    if (!inv || inv.status === "PAID" || inv.status === "CANCELLED") return null;
    // Reste dû avoirs compris : le montant que Checkout prélèvera.
    const remaining = invoiceBalance(inv).dueCents;
    if (remaining <= 0) return null;
    const info = { title: `Facture ${inv.number ?? ""}`.trim(), detail: `Montant à régler : ${formatEUR(remaining)}`, button: "Payer" };
    if (inv.paymentProcessingAt) return processing(info);
    return withMinimum(info, remaining);
  }
  if (kind === "milestone") {
    const m = await prisma.paymentMilestone.findUnique({ where: { id }, include: { quote: true } });
    if (!m || m.status === "PAID" || m.status === "CANCELLED") return null;
    // Jalon déjà facturé : le reste dû de sa facture (un avoir a pu le réduire).
    const billed = m.invoiceId ? await prisma.invoice.findUnique({ where: { id: m.invoiceId }, include: BALANCE_INCLUDE }) : null;
    const amount = billed ? invoiceBalance(billed).dueCents : m.amountCents;
    if (amount <= 0) return null;
    const info = {
      title: `${m.label}, devis ${m.quote.number ?? ""}`.trim(),
      detail: `Montant à régler : ${formatEUR(amount)}`,
      button: "Payer",
    };
    if (m.paymentProcessingAt || billed?.paymentProcessingAt) return processing(info);
    return withMinimum(info, amount);
  }
  const sub = await prisma.subscription.findUnique({ where: { id } });
  if (kind === "manage" || kind === "card") {
    if (!sub || sub.status === "ENDED" || !sub.stripeSubscriptionId) return null;
    return {
      title: sub.label,
      detail:
        kind === "card"
          ? "Mettre à jour la carte utilisée pour votre abonnement, dans l'espace sécurisé de Stripe."
          : sub.commitmentEndsAt && sub.commitmentEndsAt > new Date()
            ? // Engagé : le portail ne propose pas la résiliation (décision du 23/10/2026).
              "Régler une échéance, changer de moyen de paiement ou retrouver vos factures, dans l'espace sécurisé de Stripe."
            : "Régler une échéance, changer de moyen de paiement ou résilier votre abonnement, dans l'espace sécurisé de Stripe.",
      button: "Continuer vers Stripe",
      pageTitle: "Gérer mon abonnement, Kouzia",
    };
  }
  if (!sub || sub.status === "ENDED" || sub.stripeSubscriptionId) return null;
  const period = `par ${periodWord(sub.billingInterval)}`;
  const methods = subscriptionMethodTypes(sub.amountCents, await getCompanySettings());
  // Remise en cours (R1) : la prochaine échéance remisée, puis le tarif plein (audit du 28/10/2026, comme l'avis de 1re
  // échéance ; Stripe prélève le montant remisé par son coupon).
  const next = nextPeriodAmountCents(sub);
  const remaining = sub.discountPeriods ? sub.discountPeriods - sub.discountPeriodsBilled : 0;
  const amounts =
    next < sub.amountCents && remaining > 0
      ? `${formatEUR(next)} ${period} pendant ${remaining > 1 ? `${remaining} échéances` : "1 échéance"}, puis ${formatEUR(sub.amountCents)} ${period}`
      : `${formatEUR(sub.amountCents)} ${period}`;
  return withMinimum(
    {
      title: sub.label,
      detail: `Prélèvement de ${amounts}, ${methods.length > 1 ? "par prélèvement SEPA ou carte bancaire" : methods[0] === "card" ? "par carte bancaire" : "par prélèvement SEPA"}.`,
      button: "Mettre en place le prélèvement",
    },
    next,
  );
}

export function renderPayPage(info: NonNullable<PayPageInfo>): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(info.pageTitle ?? "Paiement Kouzia")}</title>
<style>
:root{color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;background:#0b1020;color:#e8eaf8;font:16px/1.5 system-ui,sans-serif}
main{width:100%;max-width:26rem;padding:1.5rem;border:1px solid #232d47;border-radius:1rem;background:#121a2e}
h1{margin:0 0 .5rem;font-size:1.25rem}
p{margin:0 0 1.25rem;color:#9aa1bf}
.notice{padding:.75rem 1rem;border:1px solid #6b4a10;border-radius:.75rem;background:#2a1f0b;color:#ffd58a}
button{width:100%;min-height:2.75rem;border:0;border-radius:.75rem;background:#ff9f0a;color:#1a1204;font:600 1rem system-ui,sans-serif;cursor:pointer}
button:focus-visible{outline:3px solid #e8eaf8;outline-offset:2px}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(info.title)}</h1>
<p>${escapeHtml(info.detail)}</p>
${info.notice ? `<p class="notice" role="alert">${escapeHtml(info.notice)}</p>` : ""}
${info.button ? `<form method="post"><button type="submit">${escapeHtml(info.button)}</button></form>` : ""}
</main>
</body>
</html>`;
}

/** CSP de cette page : le POST redirige vers Stripe (Checkout, portail client ou page de facture). */
export const PAY_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com https://invoice.stripe.com; base-uri 'none'; frame-ancestors 'none'";
