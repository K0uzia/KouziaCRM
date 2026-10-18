import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { BALANCE_INCLUDE, invoiceBalance, promotedStatus } from "@/lib/invoices/balance.js";
import { applySettledStatus } from "@/lib/invoices/balance-status.js";

/**
 * Remise en cohérence, au démarrage, du statut des factures qui ont des avoirs : avant le 19/10/2026, un avoir ne
 * comptait pas dans le reste dû (une facture réglée après un avoir restait « Émise » et relancée). Seules ces
 * factures sont relues, et seulement promues (Émise vers Payée ou Annulée, Payée vers Annulée), jamais rendues
 * « Émise ». Le jalon d'acompte lié suit. Rend les numéros des factures corrigées (journal de démarrage).
 */
export async function reconcileCreditedInvoiceStatuses(): Promise<string[]> {
  const invoices = await prisma.invoice.findMany({
    where: {
      documentType: InvoiceDocumentType.INVOICE,
      status: { in: [InvoiceStatus.ISSUED, InvoiceStatus.PAID] },
      creditNotes: { some: {} },
    },
    select: { id: true, number: true, status: true, totalCents: true, ...BALANCE_INCLUDE },
  });
  const fixed: string[] = [];
  for (const inv of invoices) {
    if (promotedStatus(inv.status, invoiceBalance(inv)) === inv.status) continue;
    await prisma.$transaction((tx) => applySettledStatus(tx, inv.id));
    fixed.push(inv.number ?? inv.id);
  }
  return fixed;
}
