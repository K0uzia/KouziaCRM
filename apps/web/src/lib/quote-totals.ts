import { formatEUR } from "@/lib/format";

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
  const yearCents = subs.filter((l) => l.billingInterval === "YEAR").reduce((s, l) => s + l.unitPriceCents, 0);
  const monthCents = subs.filter((l) => l.billingInterval !== "YEAR").reduce((s, l) => s + l.unitPriceCents, 0);
  return { oneOffCents, discountCents, projectCents, subscriptionCount: subs.length, yearCents, monthCents };
}

/** « 650,00 € par an » ou « 650,00 € par an + 29,00 € par mois » (sous-total des abonnements). */
export function subscriptionsTotalText(t: { yearCents: number; monthCents: number }): string {
  return [t.yearCents ? `${formatEUR(t.yearCents)} par an` : "", t.monthCents ? `${formatEUR(t.monthCents)} par mois` : ""].filter(Boolean).join(" + ");
}

/** « Proposition A », ou « Proposition A : libellé » quand le libellé dit autre chose que la lettre (même règle que le PDF). */
export function proposalTitle(letter: string, label: string | null | undefined): string {
  const base = `Proposition ${letter}`;
  const text = (label ?? "").trim();
  return !text || text.toLowerCase() === base.toLowerCase() ? base : `${base} : ${text}`;
}
