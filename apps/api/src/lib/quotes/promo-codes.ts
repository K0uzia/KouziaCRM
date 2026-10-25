import { InvoiceDocumentType, InvoiceStatus, QuoteStatus, type PromoCode } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { BillingModeError } from "@/lib/quotes/billing-mode.js";

/**
 * Codes promo (R3, décisions du 25/10/2026) : saisis par l'admin seul, sur un devis récurrent avant émission. Un code remplit
 * la remise du devis (R1), figée à l'émission ; pas de cumul avec la remise d'ouverture ni avec une remise volontaire.
 * Usages calculés, jamais stockés : devis émis encore vivants (envoyés ou signés) portant ce code. Un usage par client.
 */
export const PROMO_CODE_PATTERN = /^[A-Z0-9-]{3,32}$/;
export const normalizePromoCode = (code: string) => code.trim().toUpperCase();

type Db = Pick<typeof prisma, "invoice" | "promoCode">;

/** Devis émis vivants portant un code (hors celui qu'on enregistre ou qu'on émet). */
const liveQuotesWhere = (promoCodeId: string, excludeInvoiceId?: string) => ({
  promoCodeId,
  documentType: InvoiceDocumentType.QUOTE,
  number: { not: null },
  status: { not: InvoiceStatus.CANCELLED },
  quoteStatus: { in: [QuoteStatus.SENT, QuoteStatus.ACCEPTED] },
  ...(excludeInvoiceId ? { id: { not: excludeInvoiceId } } : {}),
});

export async function promoCodeUses(promoCodeId: string, db: Db = prisma, excludeInvoiceId?: string): Promise<number> {
  return db.invoice.count({ where: liveQuotesWhere(promoCodeId, excludeInvoiceId) });
}

export function promoServiceIds(code: Pick<PromoCode, "serviceIds">): string[] | null {
  if (!code.serviceIds) return null;
  try {
    const list = JSON.parse(code.serviceIds) as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}

/**
 * Code applicable à ce devis (client, offres de ses lignes d'abonnement, date) ; BillingModeError avec un message pour
 * l'écran sinon. Vérifié à l'enregistrement du brouillon et à l'émission.
 */
export async function assertPromoCodeApplicable(
  code: PromoCode,
  quote: { id?: string; clientId: string; serviceIds: Array<string | null> },
  now = new Date(),
  db: Db = prisma,
): Promise<void> {
  if (!code.active) throw new BillingModeError(`Code promo ${code.code} : désactivé.`);
  if (code.validFrom && now < code.validFrom) throw new BillingModeError(`Code promo ${code.code} : pas encore valable.`);
  if (code.validUntil && now > code.validUntil) throw new BillingModeError(`Code promo ${code.code} : expiré.`);
  const allowed = promoServiceIds(code);
  if (allowed && quote.serviceIds.some((id) => !id || !allowed.includes(id))) {
    throw new BillingModeError(`Code promo ${code.code} : ne s'applique pas à l'offre de ce devis.`);
  }
  if (code.maxUses !== null && (await promoCodeUses(code.id, db, quote.id)) >= code.maxUses) {
    throw new BillingModeError(`Code promo ${code.code} : plus d'utilisation disponible.`);
  }
  const sameClient = await db.invoice.count({ where: { ...liveQuotesWhere(code.id, quote.id), clientId: quote.clientId } });
  if (sameClient > 0) throw new BillingModeError(`Code promo ${code.code} : déjà utilisé par ce client.`);
}

/** Remise saisie (forme de l'API R1) tirée du code. */
export const promoAsDiscountInput = (code: Pick<PromoCode, "kind" | "value" | "months">) =>
  code.kind === "PERCENT"
    ? { kind: "PERCENT" as const, percent: code.value / 100, months: code.months }
    : { kind: "FIXED" as const, euros: code.value / 100, months: code.months };

/**
 * Code promo d'un devis : celui envoyé (null le retire), sinon celui du brouillon tant qu'aucune autre remise n'est envoyée ;
 * vérifié sur le client et les offres des lignes. Exclusif de la remise d'ouverture et de la remise volontaire.
 */
export async function resolvePromoForQuote(
  input: { promoCode?: string | null; openingDiscount?: boolean; recurringDiscount?: unknown },
  quote: { id?: string; clientId: string; lines: ReadonlyArray<{ isSubscription: boolean; serviceId?: string | null }> },
  storedPromoCodeId: string | null | undefined,
  db: Db = prisma,
  now = new Date(),
): Promise<PromoCode | null> {
  let code: PromoCode | null = null;
  if (input.promoCode !== undefined) {
    if (!input.promoCode) return null;
    if (input.openingDiscount || input.recurringDiscount) {
      throw new BillingModeError("Code promo, remise d'ouverture et remise volontaire ne se cumulent pas : choisissez l'un des trois.");
    }
    code = await db.promoCode.findUnique({ where: { code: normalizePromoCode(input.promoCode) } });
    if (!code) throw new BillingModeError("Code promo inconnu.");
  } else if (storedPromoCodeId && input.openingDiscount === undefined && input.recurringDiscount === undefined) {
    code = await db.promoCode.findUnique({ where: { id: storedPromoCodeId } });
  }
  if (code) {
    const serviceIds = quote.lines.filter((l) => l.isSubscription).map((l) => l.serviceId ?? null);
    await assertPromoCodeApplicable(code, { id: quote.id, clientId: quote.clientId, serviceIds }, now, db);
  }
  return code;
}
