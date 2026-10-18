import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { activateMilestoneCheckout } from "@/lib/payments/milestonePaymentService.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";
import { BALANCE_INCLUDE, invoiceBalance } from "@/lib/invoices/balance.js";

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

/** Reste dû avoirs compris, relu en base (les avoirs ne sont pas chargés avec le document). */
async function dueCents(invoiceId: string): Promise<number> {
  const full = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: BALANCE_INCLUDE });
  return full ? invoiceBalance(full).dueCents : 0;
}

/** Résout ou crée un lien de paiement ERP (Stripe) pour une facture impayée. */
export async function resolveInvoicePaymentUrl(
  invoice: InvoiceWithRelations,
): Promise<string | null> {
  if (invoice.documentType !== InvoiceDocumentType.INVOICE) return null;
  if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.CANCELLED) {
    return null;
  }
  if ((await dueCents(invoice.id)) <= 0) return null;

  if (invoice.checkoutUrl) return invoice.checkoutUrl;

  const milestone =
    invoice.sourceMilestone ??
    (invoice.milestoneId
      ? await prisma.paymentMilestone.findUnique({
          where: { id: invoice.milestoneId },
        })
      : null);

  if (milestone?.checkoutUrl) return milestone.checkoutUrl;

  const { getCompanySettings } = await import("@/lib/company.js");
  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled) {
    return null;
  }

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

  if (invoice.invoiceType === InvoiceType.SIMPLE && invoice.totalCents > 0) {
    const url = buildPayUrl("invoice", invoice.id);
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { checkoutUrl: url },
    });
    return url;
  }

  return null;
}
