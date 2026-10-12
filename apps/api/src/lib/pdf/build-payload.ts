import type {
  Invoice,
  InvoiceLine,
  Payment,
  PaymentMilestone,
  LegalClause,
  QuoteAcceptanceAudit,
} from "@prisma/client";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";
import type { InvoicePdfData } from "@/lib/pdf/invoice-document.js";
import {
  describePlans,
  parsePaymentPlan,
  parsePaymentPlanOffer,
  type PlanSettings,
} from "@/lib/quotes/payment-plans.js";

type InvoiceWithRelations = Invoice & {
  lines: InvoiceLine[];
  payments?: Payment[];
  creditedInvoice?: { number: string | null; issueDate: Date | null } | null;
  quote?: { number: string | null; issueDate: Date | null } | null;
  sourceMilestone?: {
    triggerText: string | null;
    triggerStepLabel?: string | null;
    triggeredAt?: Date | null;
  } | null;
  milestones: PaymentMilestone[];
  /** Dernière acceptation en premier : alimente le bloc de signature du devis. */
  quoteAcceptanceAudits?: QuoteAcceptanceAudit[];
};

type BalanceSummary = NonNullable<InvoicePdfData["invoice"]["balanceSummary"]>;

export type BuildPdfPayloadInput = {
  invoice: InvoiceWithRelations;
  legalClauses?: LegalClause[];
  balanceSummary?: BalanceSummary | null;
  /** Réglages des formules : tableaux « au choix » d'un devis non encore signé. */
  planSettings?: PlanSettings | null;
};

const PLAN_TITLE = { TWO: "Paiement en 2 fois", THREE: "Paiement en 3 fois" } as const;

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
  SEPA_DEBIT: "Prélèvement SEPA",
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
  planSettings,
}: BuildPdfPayloadInput): InvoicePdfData["invoice"] {
  const offer = parsePaymentPlanOffer(invoice.paymentPlanOffer);
  const retained = parsePaymentPlan(invoice.paymentPlan);
  const isQuote = invoice.documentType === "QUOTE";
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
    milestoneTriggerStep: invoice.sourceMilestone?.triggerStepLabel
      ? { label: invoice.sourceMilestone.triggerStepLabel, at: invoice.sourceMilestone.triggeredAt ?? null }
      : null,
    // Devis au choix non signé : les deux échéanciers ; devis signé : la formule retenue.
    paymentPlanChoice:
      isQuote && offer === "CHOICE" && !retained && planSettings
        ? describePlans(offer, invoice.totalCents, planSettings).map((p) => ({
            title: PLAN_TITLE[p.plan],
            milestones: p.milestones,
          }))
        : null,
    paymentPlanRetained: isQuote && offer && retained ? PLAN_TITLE[retained] : null,
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
    acceptance:
      invoice.quoteStatus === "ACCEPTED" && invoice.quoteSignerName && invoice.quoteDecidedAt
        ? acceptanceOf(
            invoice.quoteSignerName,
            invoice.quoteDecidedAt,
            invoice.quoteAcceptanceAudits?.[0],
          )
        : null,
  };
}

/** Bloc de signature : preuve complète si le devis a été signé depuis l'espace client. */
function acceptanceOf(
  signerName: string,
  acceptedAt: Date,
  audit: QuoteAcceptanceAudit | undefined,
): NonNullable<InvoicePdfData["invoice"]["acceptance"]> {
  if (!audit?.signatureMode) return { signerName, acceptedAt };
  return {
    signerName,
    acceptedAt,
    company: audit.signerCompany,
    mode: audit.signatureMode === "DRAWN" ? "DRAWN" : "TYPED",
    image: audit.signatureImage,
    emailMasked: audit.verifiedEmailMasked,
    proofId: audit.id,
    documentSha256: audit.originalPdfSha256,
  };
}

export type { ClientSnapshot };
