import { computeDiscountCents, lineTotalCents } from "@kouzia-erp/line-amounts";
import { formatEUR } from "@/lib/format";
import { eurosInputToCents, normalizeInterval, type BillingInterval } from "@/lib/billing-interval";
import { billedWithDocument } from "@/lib/subscription-start";

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
 * Libellé « Nom : description » séparé en nom (repris dans la phrase) et description (sur sa propre ligne, majuscule
 * et point final) ; sans « : », tout est le nom. Même règle que le PDF.
 */
export function splitLineLabel(description: string): { title: string; details: string | null } {
  const at = description.indexOf(" : ");
  if (at < 0) return { title: withoutFinalPeriod(description), details: null };
  const title = description.slice(0, at).trim();
  const rest = withoutFinalPeriod(description.slice(at + 3));
  if (!title || !rest) return { title: withoutFinalPeriod(description), details: null };
  return { title, details: `${rest.charAt(0).toUpperCase()}${rest.slice(1)}.` };
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

type EditorLine = { isSubscription: boolean; quantity: string; unitPriceEuros: string; isOptional?: boolean; subscriptionStart?: string | null };

/** Total d'une ligne saisie dans l'éditeur, en centimes, comme l'API (quantité 1 pour un abonnement). */
export function editorLineCents(l: Pick<EditorLine, "isSubscription" | "quantity" | "unitPriceEuros">): number {
  return lineTotalCents(l.isSubscription ? 1 : l.quantity.trim() || "0", eurosInputToCents(l.unitPriceEuros));
}

/**
 * Récapitulatif de l'éditeur en centimes, avec les fonctions de l'API (audit du 28/10/2026) : chaque ligne arrondie au
 * centime, remise sur la partie ponctuelle seulement et nulle sur une base négative. Devis : l'option au choix et
 * l'abonnement à 1re facture repoussée restent hors du total.
 */
export function editorTotalsCents(
  lines: EditorLine[],
  opts: { quote: boolean; discountType: string; discountPercent: string; discountEuros: string },
) {
  const subtotalCents = lines.reduce((sum, l) => (opts.quote && (!billedWithDocument(l) || l.isOptional) ? sum : sum + editorLineCents(l)), 0);
  const oneOffCents = lines.reduce((sum, l) => (l.isSubscription ? sum : sum + editorLineCents(l)), 0);
  const discountCents = computeDiscountCents(oneOffCents, {
    discountType: opts.discountType,
    discountValue:
      opts.discountType === "PERCENT"
        ? Math.round((Number(opts.discountPercent.replace(",", ".")) || 0) * 100)
        : opts.discountType === "FIXED"
          ? eurosInputToCents(opts.discountEuros)
          : 0,
  });
  return { subtotalCents, oneOffCents, discountCents, totalCents: subtotalCents - discountCents };
}

/** Propositions toutes du même mode (paiement unique ou récurrent) : seul cas où « dès X » compare des montants comparables. */
export function sameModeProposals(options: ReadonlyArray<{ billingMode?: string | null }>): boolean {
  return options.length > 0 && options.every((o) => (o.billingMode ?? "") === (options[0]!.billingMode ?? ""));
}

/**
 * Montant d'un devis à propositions non signé, tel que l'API le range : celui de la moins chère, partie ponctuelle ou
 * total sur l'engagement. Annoncé « dès X » seulement entre propositions du même mode, sinon le nombre seul.
 */
export function proposalsAmountText(count: number, options: ReadonlyArray<{ billingMode?: string | null }> | undefined, totalCents: number): string {
  if (!options || !sameModeProposals(options)) return `${count} propositions`;
  return `${count} propositions, dès ${formatEUR(totalCents)}${options[0]!.billingMode === "RECURRING" ? " sur l'engagement" : ""}`;
}

/**
 * Montant d'un devis signé tel qu'il sera facturé depuis le devis (« Montant du devis », « Facture totale ») : devis
 * mixte, le projet (partie ponctuelle remisée, figée à l'émission), comme la conversion côté API (depositBaseOf) ;
 * sinon son total.
 */
export function quoteInvoicedCents(doc: { totalCents: number; depositBaseCents?: number | null }, mixed: boolean): number {
  return mixed ? (doc.depositBaseCents ?? doc.totalCents) : doc.totalCents;
}
