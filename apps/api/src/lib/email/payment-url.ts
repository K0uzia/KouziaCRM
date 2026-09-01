import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { activateMilestoneCheckout } from "@/lib/payments/milestonePaymentService.js";
import { createRevolutOrder } from "@/lib/revolut/merchantService.js";

type InvoiceWithRelations = {
  id: string;
  number: string | null;
  documentType: InvoiceDocumentType;
  invoiceType: InvoiceType;
  status: InvoiceStatus;
  totalCents: number;
  revolutOrderId: string | null;
  checkoutUrl: string | null;
  milestoneId: string | null;
  client: { emailEncrypted: string | null };
  sourceMilestone: {
    id: string;
    checkoutUrl: string | null;
    revolutOrderId: string | null;
    status: MilestoneStatus;
    amountCents: number;
  } | null;
  payments: Array<{ amountCents: number }>;
};

function paidCents(invoice: InvoiceWithRelations): number {
  return invoice.payments.reduce((s, p) => s + p.amountCents, 0);
}

/** Résout ou crée un lien Revolut pour une facture impayée (jalon ou facture simple). */
export async function resolveInvoicePaymentUrl(
  invoice: InvoiceWithRelations,
): Promise<string | null> {
  if (invoice.documentType !== InvoiceDocumentType.INVOICE) return null;
  if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.CANCELLED) {
    return null;
  }
  if (paidCents(invoice) >= invoice.totalCents) return null;

  if (invoice.checkoutUrl) return invoice.checkoutUrl;

  const milestone =
    invoice.sourceMilestone ??
    (invoice.milestoneId
      ? await prisma.paymentMilestone.findUnique({
          where: { id: invoice.milestoneId },
        })
      : null);

  if (milestone?.checkoutUrl) return milestone.checkoutUrl;

  if (
    milestone &&
    milestone.status !== MilestoneStatus.PAID &&
    milestone.status !== MilestoneStatus.CANCELLED
  ) {
    try {
      const updated = await activateMilestoneCheckout(milestone.id, { sendEmail: false });
      return updated.checkoutUrl;
    } catch (err) {
      console.error("[payment-url] activation jalon", err);
      return null;
    }
  }

  if (
    invoice.invoiceType === InvoiceType.SIMPLE &&
    !invoice.revolutOrderId &&
    invoice.totalCents > 0
  ) {
    try {
      const clientEmail = decryptOptional(invoice.client.emailEncrypted);
      const order = await createRevolutOrder({
        amountCents: invoice.totalCents - paidCents(invoice),
        description: `Facture ${invoice.number ?? invoice.id}`,
        customerEmail: clientEmail,
        reference: invoice.id,
      });
      if (order.checkoutUrl) {
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            revolutOrderId: order.id,
            checkoutUrl: order.checkoutUrl,
          },
        });
        return order.checkoutUrl;
      }
    } catch (err) {
      console.error("[payment-url] commande Revolut facture simple", err);
    }
  }

  return null;
}
