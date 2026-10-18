/** Règles de la liste des devis, factures et avoirs (filtres, bandeau d'échéance), testées à part. */
type ListedDoc = {
  documentType: string;
  status: string;
  quoteStatus?: string | null;
  dueDate?: string | null;
};

/** Statut de la liste : un avoir émis n'est pas « à encaisser » (il ne se règle pas comme une facture). */
export const CREDIT_ISSUED = "CREDIT_ISSUED";

export function listStatus(d: ListedDoc, isQuote: boolean): string {
  if (isQuote) return d.quoteStatus || d.status;
  if (d.documentType === "CREDIT_NOTE" && d.status === "ISSUED") return CREDIT_ISSUED;
  return d.status;
}

/** Facture émise, non réglée, dont l'échéance est passée (la veille ou avant). */
export function isOverdue(d: ListedDoc, now = new Date()): boolean {
  if (d.documentType !== "INVOICE" || d.status !== "ISSUED" || !d.dueDate) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return new Date(d.dueDate) < today;
}

/** Valeurs des filtres dans l'URL (?statut=) : mots français, stables. */
export const QUOTE_STATUS_SLUG: Record<string, string> = { DRAFT: "brouillon", SENT: "envoye", ACCEPTED: "accepte", REJECTED: "refuse", EXPIRED: "expire" };
export const INVOICE_STATUS_SLUG: Record<string, string> = {
  DRAFT: "brouillon",
  ISSUED: "a-encaisser",
  PAID: "payee",
  CANCELLED: "annulee",
  [CREDIT_ISSUED]: "avoir-emis",
};
