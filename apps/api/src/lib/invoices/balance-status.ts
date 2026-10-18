import { InvoiceStatus, MilestoneStatus, type Prisma } from "@prisma/client";
import { BALANCE_INCLUDE, invoiceBalance, promotedStatus } from "@/lib/invoices/balance.js";
import { syncMilestoneOnInvoicePaid } from "@/lib/invoices/documentFlowService.js";

/**
 * Relit le solde d'une facture dans la transaction et applique son statut (Payée, Annulée), avec le jalon d'acompte
 * lié : payé avec la facture, annulé (lien de paiement retiré) quand un avoir l'annule. Rend l'ancien et le nouveau
 * statut ; le démarrage du projet (hors transaction) reste à l'appelant quand la facture devient Payée.
 */
export async function applySettledStatus(
  tx: Prisma.TransactionClient,
  invoiceId: string,
): Promise<{ before: InvoiceStatus; after: InvoiceStatus }> {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: BALANCE_INCLUDE });
  const after = promotedStatus(invoice.status, invoiceBalance(invoice));
  if (after === invoice.status) return { before: invoice.status, after };
  await tx.invoice.update({ where: { id: invoiceId }, data: { status: after } });
  if (after === InvoiceStatus.PAID) await syncMilestoneOnInvoicePaid(invoiceId, tx);
  if (after === InvoiceStatus.CANCELLED && invoice.milestoneId) {
    await tx.paymentMilestone.updateMany({
      where: { id: invoice.milestoneId, status: { not: MilestoneStatus.PAID } },
      data: { status: MilestoneStatus.CANCELLED, checkoutUrl: null },
    });
  }
  return { before: invoice.status, after };
}

/**
 * Verrou d'écriture SQLite pris en tête de transaction (une écriture sans effet) : deux avoirs, ou un avoir et un
 * paiement, sur la même facture passent l'un après l'autre et relisent chacun le solde laissé par l'autre.
 */
export async function lockInvoice(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  await tx.invoice.update({ where: { id: invoiceId }, data: { updatedAt: new Date() } });
}
