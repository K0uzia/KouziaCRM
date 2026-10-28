import { lineTotalCents } from "@/lib/money.js";
import { isCommitmentMonths } from "@/lib/subscriptions/commitment.js";

export type LineInput = {
  description: string;
  quantity: number | string;
  unitPriceCents: number;
  position?: number;
  isSubscription?: boolean;
  billingDay?: number | null;
  /** MONTH | YEAR ; null ou absent = MONTH */
  billingInterval?: string | null;
  serviceId?: string | null;
  subscriptionId?: string | null;
  /** Avenant : abonnement révisé par la ligne (gardé quand les lignes sont réécrites). */
  revisesSubscriptionId?: string | null;
  /** Départ de la facturation (lib/subscriptions/start.ts) : SIGNATURE | DELIVERY | DATE | FREE_MONTHS. */
  subscriptionStart?: string | null;
  subscriptionStartDate?: Date | string | null;
  subscriptionFreeMonths?: number | null;
  /** Ligne d'abonnement : durée d'engagement en mois (12, 24, 36) ; null = sans engagement. */
  commitmentMonths?: number | null;
  /** Titre du pack sous lequel la ligne est groupée. */
  groupTitle?: string | null;
  /** Ligne « Remise pack » (montant négatif, partie ponctuelle). */
  isPackDiscount?: boolean | null;
  /** Abonnement annuel en option, au choix du client à la signature (devis en paiement unique). */
  isOptional?: boolean | null;
  /** Choix du client sur la ligne en option : true retenue, false non retenue, null en attente. */
  optionalAccepted?: boolean | null;
};

const STARTS = new Set(["SIGNATURE", "DELIVERY", "DATE", "FREE_MONTHS"]);
const DEFERRED_STARTS = new Set(["DATE", "FREE_MONTHS"]);

/**
 * Ligne comptée dans le total du document : tout sauf un abonnement dont la 1re facture est repoussée (date précise,
 * mois offerts). Celui-ci n'est pas facturé avec le devis : il figure seulement dans l'engagement d'abonnement.
 */
export function billedWithDocument(line: { isSubscription?: boolean | null; subscriptionStart?: string | null }): boolean {
  return !line.isSubscription || !DEFERRED_STARTS.has(line.subscriptionStart ?? "");
}
/**
 * Ligne engagée : tout sauf une option en attente ou non retenue. Seules les lignes engagées comptent dans les totaux
 * enregistrés, la facturation et les abonnements (28/10/2026).
 */
export function isCommittedLine(line: { isOptional?: boolean | null; optionalAccepted?: boolean | null }): boolean {
  return !line.isOptional || line.optionalAccepted === true;
}

/** Départ d'une ligne d'abonnement : seuls les champs utiles au départ choisi sont gardés. Option : à la livraison. */
function lineStart(line: LineInput, isSubscription: boolean) {
  if (isSubscription && line.isOptional) return { subscriptionStart: "DELIVERY", subscriptionStartDate: null, subscriptionFreeMonths: null };
  const start = isSubscription && STARTS.has(line.subscriptionStart ?? "") ? line.subscriptionStart! : null;
  const date = start === "DATE" && line.subscriptionStartDate ? new Date(line.subscriptionStartDate) : null;
  const months = start === "FREE_MONTHS" && line.subscriptionFreeMonths ? line.subscriptionFreeMonths : null;
  return { subscriptionStart: start, subscriptionStartDate: date, subscriptionFreeMonths: months };
}

export type DiscountType = "NONE" | "PERCENT" | "FIXED";

export type DiscountInput = {
  discountType?: DiscountType | string | null;
  /** PERCENT : basis points (1000 = 10 %). FIXED : centimes. */
  discountValue?: number | null;
};

export function computeDiscountCents(
  subtotalCents: number,
  discount: DiscountInput = {},
): number {
  // Base nulle ou négative (lignes à prix négatif) : aucune remise. Math.min(base, …) rendait sinon une remise négative
  // qui gonflait le total sans remise affichée (audit du 27/10/2026).
  if (subtotalCents <= 0) return 0;
  const type = (discount.discountType ?? "NONE").toUpperCase();
  const value = Math.max(0, Math.floor(Number(discount.discountValue) || 0));
  if (type === "PERCENT") {
    return Math.min(subtotalCents, Math.round((subtotalCents * value) / 10000));
  }
  if (type === "FIXED") {
    return Math.min(subtotalCents, value);
  }
  return 0;
}

export function computeLineTotals(lines: LineInput[], discount: DiscountInput = {}) {
  const computed = lines.map((line, index) => {
    const isSubscription = Boolean(line.isSubscription);
    const qty = isSubscription ? 1 : Number(line.quantity);
    const total = lineTotalCents(qty, line.unitPriceCents);
    const billingDay = isSubscription ? Number(line.billingDay) : null;
    return {
      position: line.position ?? index + 1,
      description: line.description.trim(),
      quantity: qty,
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: total,
      isSubscription,
      billingDay:
        isSubscription && Number.isInteger(billingDay) && billingDay! >= 1 && billingDay! <= 28
          ? billingDay
          : null,
      billingInterval: isSubscription && (line.billingInterval === "YEAR" || line.billingInterval === "QUARTER") ? line.billingInterval : null,
      // Lien au catalogue gardé sur toute ligne (texte affiché tel quel dans la fenêtre, E3) ; obligatoire pour un abonnement.
      serviceId: line.serviceId || null,
      subscriptionId: line.subscriptionId ?? null,
      revisesSubscriptionId: isSubscription ? (line.revisesSubscriptionId ?? null) : null,
      groupTitle: line.groupTitle?.trim() || null,
      isPackDiscount: !isSubscription && Boolean(line.isPackDiscount),
      commitmentMonths: isSubscription && isCommitmentMonths(line.commitmentMonths) ? line.commitmentMonths : null,
      isOptional: isSubscription && Boolean(line.isOptional),
      optionalAccepted: isSubscription && line.isOptional ? (line.optionalAccepted ?? null) : null,
      ...lineStart(line, isSubscription),
    };
  });

  // Option en attente ou non retenue : affichée à part (« avec l'option »), jamais dans le total enregistré.
  const subtotalCents = computed.filter((l) => billedWithDocument(l) && isCommittedLine(l)).reduce((sum, l) => sum + l.lineTotalCents, 0);
  // Remise sur la partie ponctuelle seulement : la 1re période d'un abonnement reste au prix prélevé ensuite.
  const discountCents = computeDiscountCents(oneOffSubtotalCents(computed), discount);
  const discountType =
    discountCents > 0
      ? ((discount.discountType ?? "NONE").toUpperCase() as DiscountType)
      : "NONE";
  const discountValue = discountCents > 0 ? Math.max(0, Math.floor(Number(discount.discountValue) || 0)) : 0;

  return {
    lines: computed,
    subtotalCents,
    discountCents,
    discountType: discountCents > 0 ? discountType : "NONE",
    discountValue,
    totalCents: subtotalCents - discountCents,
  };
}

/** Sous-total de la partie ponctuelle (lignes hors abonnement) : seule base de la remise globale. */
export function oneOffSubtotalCents(lines: ReadonlyArray<{ isSubscription: boolean; lineTotalCents: number }>): number {
  return lines.filter((l) => !l.isSubscription).reduce((s, l) => s + l.lineTotalCents, 0);
}

/**
 * Base de l'acompte et de l'échéancier d'un devis : la partie ponctuelle, remise déduite (elle ne porte que sur
 * elle). L'abonnement n'y entre pas : il est facturé à chaque période.
 */
export function computeDepositBaseCents(
  lines: ReadonlyArray<{ isSubscription: boolean; lineTotalCents: number }>,
  subtotalCents: number,
  totalCents: number,
): number {
  const oneOff = oneOffSubtotalCents(lines);
  if (subtotalCents <= 0 || oneOff <= 0) return 0;
  const discount = Math.max(0, subtotalCents - totalCents);
  return Math.max(0, oneOff - discount);
}

/** Base d'un devis : figée à l'émission ; devis antérieur à la fonction (null) : son total. */
export function depositBaseOf(quote: { depositBaseCents: number | null; totalCents: number }): number {
  return quote.depositBaseCents ?? quote.totalCents;
}

/** Valide les lignes abonnement avant persist. */
export function assertSubscriptionLinesValid(
  lines: Array<{
    isSubscription?: boolean;
    billingDay?: number | null;
    serviceId?: string | null;
    billingInterval?: string | null;
  }>,
): void {
  // Chaque ligne d'abonnement devient son propre abonnement : mensuel et annuel peuvent se côtoyer.
  for (const line of lines) {
    if (!line.isSubscription) continue;
    const day = Number(line.billingDay);
    if (!Number.isInteger(day) || day < 1 || day > 28) {
      throw new Error("Jour de facturation d'abonnement invalide (1 à 28)");
    }
    if (!line.serviceId) {
      throw new Error("Une ligne abonnement doit être liée à une prestation du catalogue");
    }
  }
}
