import { formatEUR } from "@/lib/format";
import { normalizeInterval, type BillingInterval } from "@/lib/billing-interval";

type TotalsLine = { isSubscription?: boolean | null; lineTotalCents?: number; unitPriceCents: number; billingInterval?: string | null };

/**
 * Devis mixte (partie ponctuelle et abonnement) : deux totaux distincts. « Total du projet » = partie ponctuelle
 * remisée, base de l'acompte et de l'échéancier (figée à l'émission : depositBaseCents) ; l'abonnement se paie à
 * chaque période, à part.
 */
export function mixedQuoteTotals(lines: TotalsLine[], subtotalCents: number, totalCents: number, depositBaseCents?: number | null) {
  const oneOffCents = lines.filter((l) => !l.isSubscription).reduce((s, l) => s + (l.lineTotalCents ?? l.unitPriceCents), 0);
  const discountCents = Math.max(0, subtotalCents - totalCents);
  const projectCents = depositBaseCents ?? Math.max(0, oneOffCents - discountCents);
  const subs = lines.filter((l) => l.isSubscription);
  // Une somme par périodicité : un abonnement trimestriel n'est jamais compté « par mois ».
  const sum = (iv: BillingInterval) => subs.filter((l) => normalizeInterval(l.billingInterval) === iv).reduce((s, l) => s + l.unitPriceCents, 0);
  return { oneOffCents, discountCents, projectCents, subscriptionCount: subs.length, yearCents: sum("YEAR"), quarterCents: sum("QUARTER"), monthCents: sum("MONTH") };
}

/** « 650,00 € par an », « 650,00 € par an + 120,00 € par trimestre + 29,00 € par mois » (sous-total des abonnements). */
export function subscriptionsTotalText(t: { yearCents: number; quarterCents?: number; monthCents: number }): string {
  return [
    t.yearCents ? `${formatEUR(t.yearCents)} par an` : "",
    t.quarterCents ? `${formatEUR(t.quarterCents)} par trimestre` : "",
    t.monthCents ? `${formatEUR(t.monthCents)} par mois` : "",
  ]
    .filter(Boolean)
    .join(" + ");
}

/** Libellé repris dans une phrase (« libellé, 650,00 € par an ») : sans le point final de la description (même règle que le PDF). */
export function withoutFinalPeriod(text: string): string {
  return text.trim().replace(/\.+$/, "").trimEnd();
}

/**
 * Devis avec une option au choix : « 1 650,00 € + 650,00 € par an, soit 2 300,00 € sur les 12 mois d'engagement ». Le
 * « soit » est le total du projet sans l'option plus l'option sur toute la durée d'engagement (même phrase que le PDF).
 */
export function withOptionText(totalCents: number, yearCents: number, months: number): string {
  return `${formatEUR(totalCents)} + ${formatEUR(yearCents)} par an, soit ${formatEUR(totalCents + Math.round((yearCents * months) / 12))} sur les ${months} mois d'engagement`;
}

/** « Proposition A », ou « Proposition A : libellé » quand le libellé dit autre chose que la lettre (même règle que le PDF). */
export function proposalTitle(letter: string, label: string | null | undefined): string {
  const base = `Proposition ${letter}`;
  const text = (label ?? "").trim();
  return !text || text.toLowerCase() === base.toLowerCase() ? base : `${base} : ${text}`;
}
