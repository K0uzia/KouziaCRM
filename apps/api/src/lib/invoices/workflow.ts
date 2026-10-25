import { InvoiceDocumentType, InvoiceStatus, MilestoneStatus, QuoteStatus, type Prisma } from "@prisma/client";
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
  const siblings = await db.paymentMilestone.findMany({
    where: { quoteId: milestone.quoteId, status: { not: MilestoneStatus.CANCELLED } },
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
    where: { quoteId, status: { not: MilestoneStatus.CANCELLED } },
    orderBy: { position: "asc" },
    select: { label: true, status: true, position: true },
  });
  const deposits = milestones.slice(0, -1); // le dernier jalon est le solde
  const unpaid = deposits.find((m) => m.status !== MilestoneStatus.PAID);
  if (unpaid) {
    throw new WorkflowError(`« ${unpaid.label} » doit être payé avant la facture de solde.`);
  }
}
