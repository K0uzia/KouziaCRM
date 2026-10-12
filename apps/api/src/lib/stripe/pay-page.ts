import { prisma } from "@/lib/prisma.js";
import { formatEUR } from "@/lib/money.js";
import type { PayTokenKind } from "@/lib/stripe/pay-token.js";

/**
 * Page intermédiaire d'un lien de paiement : le GET n'a aucun effet (les antivirus de messagerie
 * préchargent les liens) ; le bouton envoie un POST qui crée la session Checkout.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type PayPageInfo = { title: string; detail: string; button: string } | null;

/** Libellé et montant affichés avant le paiement ; null si le document n'est plus payable. */
export async function payPageInfo(kind: PayTokenKind, id: string): Promise<PayPageInfo> {
  if (kind === "invoice") {
    const inv = await prisma.invoice.findUnique({ where: { id }, include: { payments: true } });
    if (!inv || inv.status === "PAID" || inv.status === "CANCELLED") return null;
    const remaining = inv.totalCents - inv.payments.reduce((s, p) => s + p.amountCents, 0);
    if (remaining <= 0) return null;
    return { title: `Facture ${inv.number ?? ""}`.trim(), detail: `Montant à régler : ${formatEUR(remaining)}`, button: "Payer" };
  }
  if (kind === "milestone") {
    const m = await prisma.paymentMilestone.findUnique({ where: { id }, include: { quote: true } });
    if (!m || m.status === "PAID" || m.status === "CANCELLED") return null;
    return {
      title: `${m.label}, devis ${m.quote.number ?? ""}`.trim(),
      detail: `Montant à régler : ${formatEUR(m.amountCents)}`,
      button: "Payer",
    };
  }
  const sub = await prisma.subscription.findUnique({ where: { id } });
  if (!sub || sub.status === "ENDED" || sub.stripeSubscriptionId) return null;
  const period = sub.billingInterval === "YEAR" ? "par an" : "par mois";
  return {
    title: sub.label,
    detail: `Prélèvement de ${formatEUR(sub.amountCents)} ${period}, par prélèvement SEPA ou carte bancaire.`,
    button: "Mettre en place le prélèvement",
  };
}

export function renderPayPage(info: NonNullable<PayPageInfo>): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Paiement Kouzia</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;background:#0b1020;color:#e8eaf8;font:16px/1.5 system-ui,sans-serif}
main{width:100%;max-width:26rem;padding:1.5rem;border:1px solid #232d47;border-radius:1rem;background:#121a2e}
h1{margin:0 0 .5rem;font-size:1.25rem}
p{margin:0 0 1.25rem;color:#9aa1bf}
button{width:100%;min-height:2.75rem;border:0;border-radius:.75rem;background:#ff9f0a;color:#1a1204;font:600 1rem system-ui,sans-serif;cursor:pointer}
button:focus-visible{outline:3px solid #e8eaf8;outline-offset:2px}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(info.title)}</h1>
<p>${escapeHtml(info.detail)}</p>
<form method="post"><button type="submit">${escapeHtml(info.button)}</button></form>
</main>
</body>
</html>`;
}

/** CSP de cette page : le POST redirige vers Stripe Checkout. */
export const PAY_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'";
