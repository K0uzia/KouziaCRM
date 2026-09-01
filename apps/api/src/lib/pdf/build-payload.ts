import type {
  Invoice,
  InvoiceLine,
  Payment,
  PaymentMilestone,
  LegalClause,
} from "@prisma/client";
import type { ClientSnapshot } from "@/lib/invoices/transitions";
import type { InvoicePdfData } from "@/lib/pdf/invoice-document";

type InvoiceWithRelations = Invoice & {
  lines: InvoiceLine[];
  payments?: Payment[];
  creditedInvoice?: { number: string | null; issueDate: Date | null } | null;
  quote?: { number: string | null; issueDate: Date | null } | null;
  sourceMilestone?: { triggerText: string | null } | null;
  milestones: PaymentMilestone[];
};

type BalanceSummary = NonNullable<InvoicePdfData["invoice"]["balanceSummary"]>;

export type BuildPdfPayloadInput = {
  invoice: InvoiceWithRelations;
  legalClauses?: LegalClause[];
  balanceSummary?: BalanceSummary | null;
};

const MILESTONE_STATUS_LABEL: Record<string, string> = {
  PENDING: "En attente",
  DUE: "Exigible",
  INVOICED: "Facturé",
  PAID: "Payé",
  OVERDUE: "En retard",
  FAILED: "Échec",
  CANCELLED: "Annulé",
};

const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CARD: "Carte bancaire",
  BANK_TRANSFER: "Virement",
  CHECK: "Chèque",
  CASH: "Espèces",
  OTHER: "Autre",
};

/**
 * Construit le payload `invoice` pour le rendu PDF à partir d'une facture
 * chargée avec ses relations. Factorise la logique auparavant dupliquée
 * entre `routes/invoices.ts` (PDF authentifié) et `routes/public.ts` (lien public).
 */
export function buildInvoicePdfPayload({
  invoice,
  legalClauses,
  balanceSummary,
}: BuildPdfPayloadInput): InvoicePdfData["invoice"] {
  return {
    number: invoice.number ?? "",
    documentType: invoice.documentType as "INVOICE" | "CREDIT_NOTE" | "QUOTE",
    invoiceType: invoice.invoiceType as "SIMPLE" | "ACOMPTE" | "SOLDE",
    issueDate: invoice.issueDate ?? new Date(),
    serviceDate: invoice.serviceDate,
    purchaseOrderRef: invoice.purchaseOrderRef,
    dueDate: invoice.dueDate,
    validUntil: invoice.validUntil,
    paymentTerms: invoice.paymentTerms,
    notes: invoice.notes,
    subtotalCents: invoice.subtotalCents,
    totalCents: invoice.totalCents,
    discountType: (invoice.discountType as "NONE" | "PERCENT" | "FIXED") ?? "NONE",
    discountValue: invoice.discountValue ?? 0,
    creditedInvoiceNumber: invoice.creditedInvoice?.number ?? null,
    creditedInvoiceIssueDate: invoice.creditedInvoice?.issueDate ?? null,
    refundMethod:
      (invoice.refundMethod as
        | "BANK_TRANSFER"
        | "DEDUCT_FROM_BALANCE"
        | "OTHER"
        | null) ?? null,
    nothingToPay: invoice.refundMethod === "BANK_TRANSFER",
    quoteNumber: invoice.quote?.number ?? null,
    quoteIssueDate: invoice.quote?.issueDate ?? null,
    marketTotalCents: invoice.marketTotalCents,
    milestoneTrigger: invoice.sourceMilestone?.triggerText ?? null,
    balanceSummary: balanceSummary ?? null,
    milestones: invoice.milestones.map((m) => ({
      label: m.label,
      percentBps: m.percentBps,
      amountCents: m.amountCents,
      triggerText: m.triggerText,
      status: MILESTONE_STATUS_LABEL[m.status] ?? m.status,
      dueDate: m.dueDate,
    })),
    payments: (invoice.payments ?? []).map((p) => ({
      paidAt: p.paidAt,
      amountCents: p.amountCents,
      method: PAYMENT_METHOD_LABEL[p.method] ?? p.method,
      reference: p.reference,
      status: invoice.status === "PAID" ? "Payé" : "Enregistré",
    })),
    lines: invoice.lines.map((l) => ({
      description: l.description,
      quantity: Number(l.quantity),
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.lineTotalCents,
      isSubscription: l.isSubscription,
      billingDay: l.billingDay,
    })),
    legalClauses: (legalClauses ?? []).map((c) => ({ title: c.title, body: c.body })),
  };
}

export type { ClientSnapshot };
