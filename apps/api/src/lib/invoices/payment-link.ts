import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
  QuoteStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { WorkflowError } from "@/lib/invoices/workflow.js";
import { buildPayUrl } from "@/lib/stripe/pay-urls.js";

/**
 * Lien de paiement d'une facture émise (acompte, solde ou facture simple).
 * - « manual » : lien (ou autre) collé à la main ;
 * - « auto » : lien ERP permanent qui ouvre Stripe Checkout ;
 * - « none » : pas de paiement en ligne (virement, IBAN sur la facture).
 * Le lien est aussi reporté sur l'échéance du devis quand la facture en vient.
 */
export type PaymentLinkChoice =
  | { mode: "none" }
  | { mode: "manual"; url: string }
  | { mode: "auto" };

export function normalizePaymentUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WorkflowError("Lien de paiement invalide.", 400);
  }
  if (url.protocol !== "https:") {
    throw new WorkflowError("Le lien de paiement doit commencer par https://", 400);
  }
  return url.toString();
}

async function loadPayable(invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      client: { select: { emailEncrypted: true } },
      sourceMilestone: true,
      payments: { select: { amountCents: true } },
    },
  });
  if (!invoice || invoice.documentType !== InvoiceDocumentType.INVOICE) {
    throw new WorkflowError("Facture introuvable.", 404);
  }
  if (invoice.status === InvoiceStatus.DRAFT || !invoice.number) {
    throw new WorkflowError("Émettez d'abord la facture.", 409);
  }
  if (invoice.status === InvoiceStatus.PAID || invoice.status === InvoiceStatus.CANCELLED) {
    throw new WorkflowError("Cette facture est déjà réglée ou annulée.", 409);
  }
  return invoice;
}

/** Enregistre (ou retire avec null) un lien de paiement collé à la main. */
export async function setInvoicePaymentLink(invoiceId: string, rawUrl: string | null) {
  const invoice = await loadPayable(invoiceId);
  const url = rawUrl ? normalizePaymentUrl(rawUrl) : null;
  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { checkoutUrl: url, revolutOrderId: null },
    });
    const m = invoice.sourceMilestone;
    if (m && m.status !== MilestoneStatus.PAID && m.status !== MilestoneStatus.CANCELLED) {
      await tx.paymentMilestone.update({
        where: { id: m.id },
        data: {
          checkoutUrl: url,
          revolutOrderId: null,
          status:
            url &&
            (m.status === MilestoneStatus.PENDING ||
              m.status === MilestoneStatus.OVERDUE ||
              m.status === MilestoneStatus.FAILED)
              ? MilestoneStatus.DUE
              : m.status,
        },
      });
    }
  });
  return url;
}

/** Crée un lien ERP permanent (Stripe Checkout à chaque clic). */
export async function generateInvoicePaymentLink(invoiceId: string): Promise<string> {
  const { getCompanySettings } = await import("@/lib/company.js");
  const settings = await getCompanySettings();
  if (!settings.moduleStripeEnabled) {
    throw new WorkflowError(
      "Le module Stripe n'est pas activé : collez un lien de paiement à la place.",
      409,
    );
  }
  const invoice = await loadPayable(invoiceId);
  const url =
    invoice.sourceMilestone
      ? buildPayUrl("milestone", invoice.sourceMilestone.id)
      : buildPayUrl("invoice", invoice.id);

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { checkoutUrl: url, revolutOrderId: null },
    });
    if (invoice.sourceMilestone) {
      await tx.paymentMilestone.update({
        where: { id: invoice.sourceMilestone.id },
        data: {
          checkoutUrl: url,
          status:
            invoice.sourceMilestone.status === MilestoneStatus.PENDING ||
            invoice.sourceMilestone.status === MilestoneStatus.OVERDUE ||
            invoice.sourceMilestone.status === MilestoneStatus.FAILED
              ? MilestoneStatus.DUE
              : invoice.sourceMilestone.status,
        },
      });
    }
  });
  return url;
}

export async function applyPaymentLinkChoice(invoiceId: string, choice: PaymentLinkChoice | undefined) {
  if (!choice) return null;
  if (choice.mode === "manual") return setInvoicePaymentLink(invoiceId, choice.url);
  if (choice.mode === "auto") return generateInvoicePaymentLink(invoiceId);
  return null;
}

/**
 * Rattache une facture libre à un devis : même client, devis signé, et devis pas
 * encore facturé par ailleurs (sinon double facturation).
 */
export async function assertQuoteLinkable(
  quoteId: string,
  clientId: string,
  invoiceId?: string,
) {
  const quote = await prisma.invoice.findUnique({
    where: { id: quoteId },
    select: { id: true, documentType: true, clientId: true, number: true, quoteStatus: true },
  });
  if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new WorkflowError("Devis introuvable.", 404);
  }
  if (quote.clientId !== clientId) {
    throw new WorkflowError("Ce devis appartient à un autre client.", 400);
  }
  if (!quote.number || quote.quoteStatus !== QuoteStatus.ACCEPTED) {
    throw new WorkflowError("Seul un devis signé peut être rattaché à une facture.", 409);
  }
  const other = await prisma.invoice.findFirst({
    where: {
      OR: [{ quoteId }, { sourceQuoteId: quoteId }],
      documentType: InvoiceDocumentType.INVOICE,
      status: { not: InvoiceStatus.CANCELLED },
      ...(invoiceId ? { id: { not: invoiceId } } : {}),
    },
    select: { number: true, invoiceType: true },
  });
  if (other) {
    const what =
      other.invoiceType === InvoiceType.SIMPLE ? "une facture" : "des factures d'acompte ou de solde";
    throw new WorkflowError(
      `Le devis ${quote.number} est déjà facturé (${what}${other.number ? `, ${other.number}` : ""}).`,
      409,
    );
  }
  return quote;
}
