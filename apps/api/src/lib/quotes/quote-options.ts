import type { Prisma, QuoteOption } from "@prisma/client";

/**
 * Devis à 2 propositions (P1 à P3, décisions du 25/10/2026). Les lignes de chaque proposition restent dans le devis émis
 * (document immuable, PDF archivé), mais seules sont facturables les lignes sans proposition (devis simple) et celles de la
 * proposition retenue à la signature. Avant la signature, aucune ligne d'un devis à propositions n'est facturable.
 */
export const BILLABLE_LINES_WHERE = {
  OR: [{ optionId: null }, { option: { selectedBy: { some: {} } } }],
} satisfies Prisma.InvoiceLineWhereInput;

export const PROPOSAL_LETTERS = ["A", "B"] as const;
export const proposalLetter = (o: Pick<QuoteOption, "position">) => PROPOSAL_LETTERS[o.position] ?? String(o.position + 1);

/** Ligne facturable, quand les lignes ont déjà été lues sans filtre. */
export const isBillableLine = (line: { optionId?: string | null }, selectedOptionId: string | null | undefined) =>
  !line.optionId || line.optionId === selectedOptionId;

/**
 * Réglages de la proposition retenue, recopiés sur le devis à la signature : conversion, abonnements, échéancier et
 * relances relisent ensuite le devis comme un devis simple. Ce qui n'a pas été figé sur la proposition reste celui du devis.
 */
export function quoteFieldsOfOption(o: QuoteOption) {
  return {
    billingMode: o.billingMode,
    paymentPlanOffer: o.paymentPlanOffer,
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
  };
}
