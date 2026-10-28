import type { Prisma, QuoteOption } from "@prisma/client";
import { z } from "zod";
import { computeDepositBaseCents } from "@/lib/invoices/totals.js";
import { recurringDiscountSummary } from "@/lib/quotes/recurring-discount-calc.js";

/**
 * Devis à 2 propositions (P1 à P3, décisions du 25/10/2026). Les lignes de chaque proposition restent dans le devis émis
 * (document immuable, PDF archivé), mais seules sont facturables les lignes sans proposition (devis simple) et celles de la
 * proposition retenue à la signature. Avant la signature, aucune ligne d'un devis à propositions n'est facturable.
 * Ligne en option (28/10/2026) : facturable seulement si le client l'a retenue à la signature.
 */
export const BILLABLE_LINES_WHERE = {
  AND: [
    { OR: [{ optionId: null }, { option: { selectedBy: { some: {} } } }] },
    { OR: [{ isOptional: false }, { optionalAccepted: true }] },
  ],
} satisfies Prisma.InvoiceLineWhereInput;

export const PROPOSAL_LETTERS = ["A", "B"] as const;
export const proposalLetter = (o: Pick<QuoteOption, "position">) => PROPOSAL_LETTERS[o.position] ?? String(o.position + 1);

/** « Proposition A », ou « Proposition A : libellé » quand le libellé dit autre chose que la lettre (28/10/2026). */
export function proposalTitle(letter: string, label: string | null | undefined): string {
  const base = `Proposition ${letter}`;
  const text = (label ?? "").trim();
  return !text || text.toLowerCase() === base.toLowerCase() ? base : `${base} : ${text}`;
}

/** Ligne facturable, quand les lignes ont déjà été lues sans filtre. */
export const isBillableLine = (
  line: { optionId?: string | null; isOptional?: boolean | null; optionalAccepted?: boolean | null },
  selectedOptionId: string | null | undefined,
) => (!line.optionId || line.optionId === selectedOptionId) && (!line.isOptional || line.optionalAccepted === true);

/**
 * Réglages de la proposition retenue, recopiés sur le devis à la signature : conversion, abonnements, échéancier et
 * relances relisent ensuite le devis comme un devis simple. Ce qui n'a pas été figé sur la proposition reste celui du devis.
 */
export function quoteFieldsOfOption(o: QuoteOption) {
  return {
    billingMode: o.billingMode,
    paymentPlanOffer: o.paymentPlanOffer,
    offeredIntervals: o.offeredIntervals,
    discountType: o.discountType,
    discountValue: o.discountValue,
    recurringDiscountKind: o.recurringDiscountKind,
    recurringDiscountValue: o.recurringDiscountValue,
    recurringDiscountMonths: o.recurringDiscountMonths,
    openingDiscount: o.openingDiscount,
    promoCodeId: o.promoCodeId,
    subtotalCents: o.subtotalCents,
    totalCents: o.totalCents,
    ...(o.depositBaseCents !== null ? { depositBaseCents: o.depositBaseCents } : {}),
    ...(o.paymentScheduleSnapshot ? { paymentScheduleSnapshot: o.paymentScheduleSnapshot } : {}),
    // Compris et non compris de la proposition retenue (28/10/2026) : le devis signé les porte comme un devis simple.
    ...(o.scopeSnapshot ? { scopeSnapshot: o.scopeSnapshot as Prisma.InputJsonValue } : {}),
  };
}

/** Choix du client sur une ligne en option (signature). */
export type OptionalChoice = { id: string; accepted: boolean };
export const optionalLinesSchema = z.array(z.object({ id: z.string().min(1).max(64), accepted: z.boolean() })).max(20).optional();

/**
 * Choix des options à la signature (28/10/2026) : une réponse explicite, et une seule, pour chaque ligne en option de la
 * formule signée ; rien d'autre. Toutes sources (espace client, hors ligne, messagerie) : jamais de choix par défaut.
 */
export function optionalChoicesError(optionalLineIds: ReadonlyArray<string>, choices: ReadonlyArray<OptionalChoice> | null | undefined): "REQUIRED" | "INVALID" | null {
  const given = choices ?? [];
  const expected = new Set(optionalLineIds);
  if (new Set(given.map((c) => c.id)).size !== given.length || given.some((c) => !expected.has(c.id))) return "INVALID";
  if (optionalLineIds.some((id) => !given.some((c) => c.id === id))) return "REQUIRED";
  return null;
}

type ComparableLine = {
  isSubscription: boolean;
  lineTotalCents: number;
  unitPriceCents: number;
  billingInterval: string | null;
  commitmentMonths: number | null;
  isOptional?: boolean | null;
  optionalAccepted?: boolean | null;
};

/**
 * Montant comparable d'une proposition (audit du 28/10/2026) : paiement unique, sa partie ponctuelle remisée ; mode
 * récurrent, le total sur la durée d'engagement (remise récurrente comprise). Jamais une mensualité face à un prix
 * ponctuel : « dès X » ne compare que des propositions du même mode.
 */
export function proposalComparableCents(
  option: {
    billingMode: string | null;
    subtotalCents: number;
    totalCents: number;
    recurringDiscountKind: string | null;
    recurringDiscountValue: number | null;
    recurringDiscountMonths: number | null;
    openingDiscount: boolean;
  },
  lines: ReadonlyArray<ComparableLine>,
): number {
  const committed = lines.filter((l) => !l.isOptional || l.optionalAccepted === true);
  if (option.billingMode !== "RECURRING") return computeDepositBaseCents(committed, option.subtotalCents, option.totalCents);
  const subs = committed.filter((l) => l.isSubscription);
  const first = subs[0];
  if (!first) return option.totalCents;
  const amountCents = subs.reduce((s, l) => s + l.unitPriceCents, 0);
  const months = first.commitmentMonths ?? 12;
  const step = first.billingInterval === "YEAR" ? 12 : first.billingInterval === "QUARTER" ? 3 : 1;
  const discounted = recurringDiscountSummary(option, amountCents, first.billingInterval, months)?.totalCommitmentCents;
  return discounted ?? amountCents * Math.ceil(months / step);
}

/** Propositions toutes du même mode (paiement unique ou récurrent) : seul cas où « dès X » a un sens. */
export function sameModeProposals(options: ReadonlyArray<{ billingMode: string | null }>): boolean {
  return options.length > 0 && options.every((o) => (o.billingMode ?? "") === (options[0]!.billingMode ?? ""));
}
