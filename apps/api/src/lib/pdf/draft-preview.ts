import type { Invoice } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { computeDepositBaseCents, type computeLineTotals } from "@/lib/invoices/totals.js";
import { computeMilestoneAmounts } from "@/lib/quotes/milestones.js";
import {
  effectiveOffer,
  initialPlan,
  isSubscriptionOnly,
  planTemplate,
  type PaymentPlanOffer,
} from "@/lib/quotes/payment-plans.js";
import { buildInvoicePdfPayload, type BuildPdfPayloadInput, type ClientSnapshot } from "@/lib/pdf/build-payload.js";
import { enrichCompanyForPdf } from "@/lib/pdf/brand-assets.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";
import { buildClientSnapshot } from "@/lib/invoices/documentFlowService.js";
import {
  assessCreditNoteEligibility,
  creditNoteContent,
  CreditNoteError,
  validateCreditNoteAmount,
  type CreateCreditNoteInput,
} from "@/lib/invoices/credit-note-service.js";

/**
 * Aperçu d'un devis, d'une facture ou d'un avoir avant création : le brouillon du formulaire passe par le même
 * payload et le même gabarit que le document émis, avec les calculs de l'émission (offre de paiement,
 * base de l'acompte, échéancier) faits en mémoire. Lecture seule : aucune écriture, aucun numéro.
 */

const DAY = 24 * 60 * 60 * 1000;

export type DraftPreviewInput = {
  documentType: "INVOICE" | "QUOTE";
  clientId: string;
  notes: string | null;
  paymentTerms: string | null;
  serviceDate: Date | null;
  purchaseOrderRef: string | null;
  validUntil: Date | null;
  sourceQuoteId: string | null;
  paymentPlanOffer: PaymentPlanOffer | null;
  totals: ReturnType<typeof computeLineTotals>;
};

/** null : client introuvable. */
export async function renderDraftPreviewPdf(input: DraftPreviewInput, now = new Date()): Promise<Buffer | null> {
  const [settings, client, clauses, sourceQuote] = await Promise.all([
    getCompanySettings(),
    prisma.client.findUnique({ where: { id: input.clientId } }),
    // Lecture directe : listActiveLegalClauses créerait les clauses manquantes (écriture).
    prisma.legalClause.findMany({ where: { active: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
    input.sourceQuoteId
      ? prisma.invoice.findFirst({
          where: { id: input.sourceQuoteId, clientId: input.clientId, documentType: "QUOTE" },
          select: { number: true, issueDate: true },
        })
      : null,
  ]);
  if (!client) return null;

  const snapshot: ClientSnapshot = {
    displayName: client.displayName,
    type: client.type,
    email: decryptOptional(client.emailEncrypted),
    phone: decryptOptional(client.phoneEncrypted),
    siret: decryptOptional(client.siretEncrypted),
    addressLine1: client.addressLine1,
    addressLine2: client.addressLine2,
    postalCode: client.postalCode,
    city: client.city,
    country: client.country,
  };

  const isQuote = input.documentType === "QUOTE";
  const { lines, subtotalCents, totalCents, discountType, discountValue } = input.totals;
  // Comme issueQuote : base de l'acompte, offre figée (seuil du 3 fois) et jalons de la formule initiale.
  const depositBaseCents = isQuote ? computeDepositBaseCents(lines, subtotalCents, totalCents) : null;
  const offer: PaymentPlanOffer | null = isQuote
    ? isSubscriptionOnly(lines)
      ? "NONE"
      : effectiveOffer(input.paymentPlanOffer ?? (settings.paymentChoiceDefault ? "CHOICE" : "TWO"), depositBaseCents ?? 0, settings)
    : null;
  const milestones =
    isQuote && offer && offer !== "NONE"
      ? computeMilestoneAmounts(depositBaseCents ?? 0, planTemplate(initialPlan(offer), settings)).map((m) => ({
          label: m.label,
          percentBps: m.percentBps,
          amountCents: m.amountCents,
          triggerText: m.triggerText,
          status: "PENDING",
          dueDate: null,
        }))
      : [];
  const validUntil = isQuote ? (input.validUntil ?? new Date(now.getTime() + 30 * DAY)) : input.validUntil;

  const invoice = {
    id: "apercu",
    number: null,
    documentType: input.documentType,
    invoiceType: "SIMPLE",
    status: "DRAFT",
    issueDate: now,
    serviceDate: isQuote ? null : input.serviceDate,
    purchaseOrderRef: input.purchaseOrderRef,
    dueDate: isQuote ? validUntil : now,
    validUntil,
    paymentTerms: input.paymentTerms ?? (isQuote ? "Devis valable 30 jours" : "Paiement à réception"),
    notes: input.notes,
    subtotalCents,
    totalCents,
    discountType,
    discountValue,
    refundMethod: null,
    marketTotalCents: null,
    paymentPlanOffer: offer,
    paymentPlan: null,
    depositBaseCents,
    quoteStatus: isQuote ? "DRAFT" : null,
    quoteSignerName: null,
    quoteDecidedAt: null,
    creditedInvoice: null,
    quote: sourceQuote,
    sourceMilestone: null,
    milestones,
    payments: [],
    quoteAcceptanceAudits: [],
    lines,
  } as unknown as Invoice & BuildPdfPayloadInput["invoice"];

  return renderInvoicePdf({
    draft: true,
    company: await enrichCompanyForPdf(settings),
    client: snapshot,
    invoice: buildInvoicePdfPayload({
      invoice,
      legalClauses: clauses,
      clientType: snapshot.type,
      planSettings: settings,
      cgv: { published: settings.cgvPublished, url: settings.cgvUrl, version: settings.cgvVersion },
    }),
  });
}

export type CreditNotePreviewInput = {
  invoiceId: string;
  amountCents: number;
  reason: CreateCreditNoteInput["reason"];
  reasonDetail: string | null;
  refundMethod: CreateCreditNoteInput["refundMethod"];
  issueDate: Date;
};

/**
 * Aperçu d'un avoir avant émission : mêmes contrôles d'éligibilité et de montant, mêmes textes
 * (creditNoteContent) et même document que createCreditNote, montants négatifs et référence de la
 * facture d'origine compris. Lecture seule : aucun avoir créé, aucun numéro d'avoir consommé.
 */
export async function renderCreditNotePreviewPdf(input: CreditNotePreviewInput): Promise<Buffer> {
  const eligibility = await assessCreditNoteEligibility(input.invoiceId);
  if (!eligibility.allowed) {
    throw new CreditNoteError(eligibility.message ?? "Avoir non autorisé", eligibility.code ?? "BAD_STATUS");
  }
  const split = validateCreditNoteAmount(eligibility, input.amountCents, input.refundMethod);
  const [settings, original, clauses] = await Promise.all([
    getCompanySettings(),
    prisma.invoice.findUniqueOrThrow({
      where: { id: input.invoiceId },
      include: { quote: { select: { number: true, issueDate: true } } },
    }),
    prisma.legalClause.findMany({ where: { active: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
  ]);
  const snapshot = (original.clientSnapshot as ClientSnapshot | null) ?? (await buildClientSnapshot(original.clientId));
  const { description, notes } = creditNoteContent(original, input, split);
  const amount = input.amountCents;

  const creditNote = {
    id: "apercu",
    number: null,
    documentType: "CREDIT_NOTE",
    invoiceType: "SIMPLE",
    status: "ISSUED",
    issueDate: input.issueDate,
    serviceDate: null,
    purchaseOrderRef: null,
    dueDate: input.issueDate,
    validUntil: null,
    paymentTerms: original.paymentTerms,
    notes,
    subtotalCents: -amount,
    totalCents: -amount,
    discountType: "NONE",
    discountValue: 0,
    refundMethod: input.refundMethod,
    marketTotalCents: null,
    paymentPlanOffer: null,
    paymentPlan: null,
    depositBaseCents: null,
    quoteStatus: null,
    quoteSignerName: null,
    quoteDecidedAt: null,
    creditedInvoice: { number: original.number, issueDate: original.issueDate },
    quote: original.quote,
    sourceMilestone: null,
    milestones: [],
    payments: [],
    quoteAcceptanceAudits: [],
    lines: [
      {
        position: 0,
        description,
        quantity: 1,
        unitPriceCents: -amount,
        lineTotalCents: -amount,
        isSubscription: false,
        billingDay: null,
        billingInterval: null,
        groupTitle: null,
        isPackDiscount: false,
        subscriptionStart: null,
        subscriptionStartDate: null,
        subscriptionFreeMonths: null,
      },
    ],
  } as unknown as Invoice & BuildPdfPayloadInput["invoice"];

  return renderInvoicePdf({
    draft: true,
    company: await enrichCompanyForPdf(settings),
    client: snapshot,
    invoice: buildInvoicePdfPayload({
      invoice: creditNote,
      legalClauses: clauses,
      clientType: snapshot.type,
      planSettings: settings,
      cgv: { published: settings.cgvPublished, url: settings.cgvUrl, version: settings.cgvVersion },
    }),
  });
}
