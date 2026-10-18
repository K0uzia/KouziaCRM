import { InvoiceStatus } from "@prisma/client";

/**
 * Reste dû d'une facture, avoirs compris (décision d'Alexandre du 18/10/2026) :
 * - net = total - avoirs liés ;
 * - encaissé net = paiements de la facture - remboursements (paiements négatifs portés par ses avoirs) ;
 * - reste dû = max(0, net - encaissé net).
 * La facture est « Payée » quand le reste dû est nul (net positif), « Annulée » quand les avoirs couvrent tout le total.
 * Un avoir n'est jamais une pièce à encaisser : il réduit le net de la facture qu'il corrige.
 * Payment.refundedCents (remboursement fait dans Stripe, relevé par le webhook) n'entre volontairement pas dans le
 * calcul : le remboursement compté est la ligne négative de l'avoir (ou du trop-perçu) ; compter aussi refundedCents
 * le déduirait deux fois. Un remboursement fait dans Stripe se régularise donc par un avoir avec remboursement.
 */
export type BalanceSource = {
  totalCents: number;
  payments: ReadonlyArray<{ amountCents: number }>;
  creditNotes?: ReadonlyArray<{ totalCents: number; payments?: ReadonlyArray<{ amountCents: number }> }>;
};

export type InvoiceBalance = {
  totalCents: number;
  /** Somme des avoirs émis sur la facture (positive). */
  creditedCents: number;
  /** Total moins avoirs, jamais négatif. */
  netCents: number;
  /** Paiements reçus sur la facture. */
  paidCents: number;
  /** Remboursements faits au client par ses avoirs (positive). */
  refundedCents: number;
  /** Paiements moins remboursements : ce qui reste réellement encaissé. */
  cashInCents: number;
  /** Ce que le client doit encore. */
  dueCents: number;
};

/** Relations à charger pour calculer le solde d'une facture (include Prisma). */
export const BALANCE_INCLUDE = {
  payments: { select: { amountCents: true } },
  creditNotes: { select: { totalCents: true, payments: { select: { amountCents: true } } } },
} as const;

export function invoiceBalance(doc: BalanceSource): InvoiceBalance {
  const creditedCents = (doc.creditNotes ?? []).reduce((s, cn) => s + Math.abs(cn.totalCents), 0);
  const refundedCents = (doc.creditNotes ?? []).reduce(
    (s, cn) => s + (cn.payments ?? []).reduce((r, p) => r + (p.amountCents < 0 ? -p.amountCents : 0), 0),
    0,
  );
  const paidCents = doc.payments.reduce((s, p) => s + p.amountCents, 0);
  const netCents = Math.max(0, doc.totalCents - creditedCents);
  const cashInCents = paidCents - refundedCents;
  return {
    totalCents: doc.totalCents,
    creditedCents,
    netCents,
    paidCents,
    refundedCents,
    cashInCents,
    dueCents: Math.max(0, netCents - cashInCents),
  };
}

/**
 * Statut d'une facture émise d'après son solde : Annulée si les avoirs couvrent le total, Payée si plus rien n'est
 * dû, sinon Émise. Brouillon et facture déjà annulée gardent leur statut.
 */
export function settledStatus(current: InvoiceStatus, balance: InvoiceBalance): InvoiceStatus {
  if (current === InvoiceStatus.DRAFT || current === InvoiceStatus.CANCELLED) return current;
  if (balance.totalCents > 0 && balance.netCents === 0) return InvoiceStatus.CANCELLED;
  if (balance.dueCents === 0) return InvoiceStatus.PAID;
  return InvoiceStatus.ISSUED;
}

/** Plafonds d'un nouvel avoir : déduction sur le reste dû, remboursement de l'encaissé net, jamais plus que le net. */
export function creditNoteCaps(balance: InvoiceBalance): { deductCents: number; refundCents: number; maxCents: number } {
  const deductCents = balance.dueCents;
  const refundCents = Math.max(0, Math.min(balance.cashInCents, balance.netCents));
  return { deductCents, refundCents, maxCents: Math.min(balance.netCents, deductCents + refundCents) };
}

/**
 * Champs de solde d'une facture pour l'API (liste, fiche, espace client) ; null pour un devis ou un avoir.
 * Le document doit être chargé avec BALANCE_INCLUDE (ou payments et creditNotes avec leurs paiements).
 */
export function balanceFields(doc: BalanceSource & { documentType: string }): Omit<InvoiceBalance, "totalCents" | "paidCents"> | null {
  if (doc.documentType !== "INVOICE") return null;
  const { totalCents: _t, paidCents: _p, ...fields } = invoiceBalance(doc);
  return fields;
}

/**
 * Statut après un paiement, un avoir ou une remise en cohérence : seulement vers Payée ou Annulée, jamais une facture
 * Payée rendue « Émise » (une donnée ancienne ou importée relancerait le client à tort).
 */
export function promotedStatus(current: InvoiceStatus, balance: InvoiceBalance): InvoiceStatus {
  const next = settledStatus(current, balance);
  return current === InvoiceStatus.PAID && next === InvoiceStatus.ISSUED ? current : next;
}

/** Trop-perçu : encaissé net au-delà du net (paiement reçu après un avoir, remboursement pas encore fait). */
export function overpaidCents(balance: InvoiceBalance): number {
  return Math.max(0, balance.cashInCents - balance.netCents);
}

/** Champs de solde de l'administration : ceux de l'espace client, plus le trop-perçu à rembourser. */
export function adminBalanceFields(doc: BalanceSource & { documentType: string }) {
  const fields = balanceFields(doc);
  return fields ? { ...fields, overpaidCents: Math.max(0, fields.cashInCents - fields.netCents) } : null;
}
