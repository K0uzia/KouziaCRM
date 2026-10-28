import { InvoiceDocumentType, InvoiceStatus, InvoiceType, MilestoneStatus, QuoteStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";

/**
 * Ordre imposé du parcours commercial :
 * 1. devis brouillon → émis (numéro, envoi) ;
 * 2. émis → signé par le client (espace client, réponse email, ou signature hors ligne enregistrée) ;
 * 3. signé → facture d'acompte (ou facture totale pour une petite prestation) ;
 * 4. acompte facturé → paiement (pointage, lien de paiement) → création et démarrage du projet ;
 * 5. acomptes payés → facture de solde.
 * Chaque étape vérifie la précédente côté serveur : l'interface ne fait que refléter ces règles.
 */
export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

/** Le devis doit être émis puis signé avant toute facture. */
export async function assertQuoteSigned(quoteId: string, db: Db = prisma) {
  const quote = await db.invoice.findUnique({
    where: { id: quoteId },
    select: { documentType: true, status: true, number: true, quoteStatus: true },
  });
  if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new WorkflowError("Devis introuvable", 404);
  }
  if (quote.status === InvoiceStatus.DRAFT || !quote.number) {
    throw new WorkflowError("Émettez d'abord le devis : il doit être envoyé puis signé par le client avant toute facture.");
  }
  if (quote.quoteStatus === QuoteStatus.REJECTED || quote.quoteStatus === QuoteStatus.EXPIRED) {
    throw new WorkflowError("Ce devis a été refusé ou a expiré : il ne peut plus être facturé.");
  }
  if (quote.quoteStatus === QuoteStatus.WITHDRAWN || quote.quoteStatus === QuoteStatus.CANCELLED) {
    throw new WorkflowError("Ce devis a été retiré ou sa commande annulée : il ne peut plus être facturé.");
  }
  if (quote.quoteStatus !== QuoteStatus.ACCEPTED) {
    throw new WorkflowError(
      "Le devis n'est pas encore signé. Attendez la validation du client (espace client) ou enregistrez une signature hors ligne.",
    );
  }
}

/**
 * Nature de la facture d'une échéance (art. 289 du CGI, audit du 25/10/2026) : échéance unique (comptant) = facture
 * simple du devis ; dernière échéance d'un échéancier (« Solde », « 3e échéance »…) = facture de solde, qui rappelle
 * le marché et les acomptes ; les autres = factures d'acompte.
 */
export async function milestoneInvoiceKind(
  milestone: { quoteId: string; position: number; label: string; percentBps: number },
  db: Db = prisma,
): Promise<"FULL" | "BALANCE" | "DEPOSIT"> {
  // Échéances annulées comprises (audit du 28/10/2026) : un avoir qui annule la 1re échéance ne fait pas de la
  // dernière un acompte partiel, elle reste le solde du marché.
  const siblings = await db.paymentMilestone.findMany({
    where: { quoteId: milestone.quoteId },
    select: { position: true },
  });
  // Comptant : une seule échéance qui couvre tout le devis. Une échéance seule partielle reste un acompte.
  if (siblings.length <= 1) return milestone.percentBps >= 10_000 ? "FULL" : "DEPOSIT";
  const last = Math.max(...siblings.map((m) => m.position));
  return milestone.position === last || milestone.label.toLowerCase().includes("solde") ? "BALANCE" : "DEPOSIT";
}

/** Un acompte ne se règle qu'une fois sa facture émise. */
export function assertMilestoneInvoiced(milestone: { invoiceId: string | null; label: string }) {
  if (!milestone.invoiceId) {
    throw new WorkflowError(`Facturez d'abord « ${milestone.label} » : le paiement se rattache à sa facture.`);
  }
}

/** La facture de solde n'arrive qu'après le paiement des acomptes. */
export async function assertDepositsPaid(quoteId: string, db: Db = prisma) {
  const milestones = await db.paymentMilestone.findMany({
    where: { quoteId },
    orderBy: { position: "asc" },
    select: { label: true, status: true, position: true },
  });
  // Le dernier jalon (annulés compris, comme milestoneInvoiceKind) est le solde ; un acompte annulé par avoir ne bloque pas.
  const deposits = milestones.slice(0, -1).filter((m) => m.status !== MilestoneStatus.CANCELLED);
  const unpaid = deposits.find((m) => m.status !== MilestoneStatus.PAID);
  if (unpaid) {
    throw new WorkflowError(`« ${unpaid.label} » doit être payé avant la facture de solde.`);
  }
}

/**
 * Mentions obligatoires d'un document émis (art. 242 nonies A, annexe II du CGI ; art. L441-9 du Code de commerce) :
 * nom et adresse du client. Vérifié avant l'attribution du numéro : un refus ne consomme aucun numéro.
 */
export async function assertClientIdentified(clientId: string, db: Db = prisma) {
  const client = await db.client.findUnique({
    where: { id: clientId },
    select: { displayName: true, addressLine1: true, postalCode: true },
  });
  const missing = [
    !client?.displayName?.trim() ? "le nom" : null,
    !client?.addressLine1?.trim() ? "l'adresse" : null,
    !client?.postalCode?.trim() ? "le code postal" : null,
  ].filter((f): f is string => f !== null);
  if (missing.length === 0) return;
  const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} et ${missing[missing.length - 1]}`;
  throw new WorkflowError(`Fiche client incomplète : ajoutez ${list} du client avant d'émettre ce document (mention obligatoire).`, 400);
}

/**
 * Facture totale active du devis (conversion ou facture simple rattachée) : null si aucune. Une facture annulée par
 * avoir ne compte plus, le devis peut être refacturé.
 */
export async function activeTotalInvoiceOf(quoteId: string, db: Db = prisma) {
  return db.invoice.findFirst({
    where: {
      OR: [{ quoteId }, { sourceQuoteId: quoteId }],
      documentType: InvoiceDocumentType.INVOICE,
      invoiceType: InvoiceType.SIMPLE,
      status: { not: InvoiceStatus.CANCELLED },
    },
    select: { id: true, number: true, status: true },
  });
}

/** Échéance d'un devis déjà facturé en totalité : plus rien à payer sur l'échéancier (ni lien, ni paiement en ligne). */
export async function assertNoTotalInvoice(quoteId: string, db: Db = prisma) {
  const total = await activeTotalInvoiceOf(quoteId, db);
  if (total) {
    throw new WorkflowError(
      `Ce devis est déjà facturé en totalité${total.number ? ` (${total.number})` : ""} : ses échéances ne sont plus à payer.`,
    );
  }
}
