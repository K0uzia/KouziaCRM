import { prisma } from "@/lib/prisma.js";
import { alertAdmin } from "@/lib/stripe/alert.js";
import { isAllowedPaymentUrl } from "@/lib/invoices/payment-link.js";

/** kind de l'alerte : sert d'anti-doublon (EmailOutbox.reviewKind + documentId) et de source à la cloche. */
export const FOREIGN_LINK_KIND = "payment_link_foreign";

/** Hôte d'un lien enregistré, pour l'alerte (jamais le chemin, qui peut porter un jeton). */
export function linkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "lien illisible";
  }
}

/**
 * Liens enregistrés avant la règle « Stripe seulement » (27/10/2026) : chaque facture ou échéance de devis dont le lien
 * de paiement est hors liste est signalée une fois à Alexandre (e-mail d'alerte, cloche et push). Lecture seule : rien
 * n'est modifié, le lien se corrige depuis la fiche. Retourne le nombre de documents signalés à ce passage.
 */
export async function reportForeignPaymentLinks(): Promise<number> {
  const [invoices, milestones] = await Promise.all([
    prisma.invoice.findMany({
      where: { documentType: "INVOICE", checkoutUrl: { not: null } },
      select: { id: true, number: true, checkoutUrl: true },
    }),
    prisma.paymentMilestone.findMany({
      where: { checkoutUrl: { not: null } },
      select: { id: true, label: true, checkoutUrl: true, quote: { select: { number: true } } },
    }),
  ]);
  const foreign = [
    ...invoices.map((i) => ({ id: i.id, url: i.checkoutUrl!, label: `facture ${i.number ?? "(brouillon)"}` })),
    ...milestones.map((m) => ({ id: m.id, url: m.checkoutUrl!, label: `échéance « ${m.label} » du devis ${m.quote.number ?? "(brouillon)"}` })),
  ].filter((d) => !isAllowedPaymentUrl(d.url));
  if (!foreign.length) return 0;

  const reported = new Set(
    (await prisma.emailOutbox.findMany({
      where: { reviewKind: FOREIGN_LINK_KIND, documentId: { in: foreign.map((d) => d.id) } },
      select: { documentId: true },
    })).map((r) => r.documentId),
  );
  let count = 0;
  for (const d of foreign) {
    if (reported.has(d.id)) continue;
    // Sans e-mail de l'entreprise, rien n'est mis en file : le document sera signalé au prochain passage.
    const sent = await alertAdmin(
      `Lien de paiement hors Stripe : ${d.label}`,
      `Le lien de paiement enregistré sur la ${d.label} pointe vers ${linkHost(d.url)}, hors des liens acceptés (Stripe ou l'ERP). Il n'est pas affiché dans l'espace client. Rien n'a été modifié : remplacer ou retirer le lien depuis la fiche.`,
      { kind: FOREIGN_LINK_KIND, documentId: d.id },
    );
    if (sent) count += 1;
  }
  return count;
}
