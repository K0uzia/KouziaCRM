import type { Invoice } from "@prisma/client";
import { NO_RECURRING_DISCOUNT, type RecurringDiscountFields } from "@/lib/quotes/recurring-discount.js";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { getCompanySettings } from "@/lib/company.js";
import { computeDepositBaseCents, isCommittedLine, type computeLineTotals } from "@/lib/invoices/totals.js";
import { buildQuoteScope } from "@/lib/quotes/scope.js";
import { defaultQuoteValidUntil } from "@/lib/quotes/validity.js";
import { computeMilestoneAmounts } from "@/lib/quotes/milestones.js";
import {
  initialPlan,
  milestoneAmounts,
  offerAtIssue,
  planTemplate,
  type BillingMode,
  type PaymentPlanOffer,
} from "@/lib/quotes/payment-plans.js";
import { buildInvoicePdfPayload, type BuildPdfPayloadInput, type ClientSnapshot } from "@/lib/pdf/build-payload.js";
import { enrichCompanyForPdf } from "@/lib/pdf/brand-assets.js";
import { renderInvoicePdf } from "@/lib/pdf/render.js";
import { buildClientSnapshot } from "@/lib/invoices/documentFlowService.js";
import { readClientSnapshot } from "@/lib/invoices/client-snapshot.js";
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
  billingMode: BillingMode | null;
  totals: ReturnType<typeof computeLineTotals>;
  /** Devis récurrent : remise sur les premières échéances (R1), déjà vérifiée. */
  recurringDiscount?: RecurringDiscountFields;
  /** Code promo appliqué (R3), déjà vérifié. */
  promoCode?: { code: string; conditionText: string | null } | null;
  /** Devis récurrent : rythmes au choix du client, déjà vérifiés (null : un seul rythme). */
  offeredIntervals?: string | null;
  /** Devis à 2 propositions (P2) : vérifiées par la route ; le devis lui-même reste neutre. */
  options?: Array<{
    label: string;
    billingMode: BillingMode;
    paymentPlanOffer: PaymentPlanOffer | null;
    offeredIntervals?: string | null;
    totals: ReturnType<typeof computeLineTotals>;
    recurringDiscount: RecurringDiscountFields;
    promoCode: { id: string; code: string; conditionText: string | null } | null;
  }>;
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
  const committed = lines.filter(isCommittedLine);
  const depositBaseCents = isQuote ? computeDepositBaseCents(committed, subtotalCents, totalCents) : null;
  const mode = isQuote ? input.billingMode : null;
  // Compris et non compris tels qu'ils seraient figés à l'émission.
  const scopeOf = (m: BillingMode | null, ls: ReadonlyArray<{ serviceId?: string | null }>) =>
    buildQuoteScope(m, ls, { clauses, clientType: client.type, company: settings });
  // Même règle que issueQuote (offerAtIssue) ; offre non choisie : celle des réglages proposée par le formulaire.
  const offer: PaymentPlanOffer | null = isQuote
    ? offerAtIssue(mode, committed, depositBaseCents ?? 0, input.paymentPlanOffer ?? (settings.paymentChoiceDefault ? "CHOICE" : "TWO"), settings)
    : null;
  const milestones =
    isQuote && offer && offer !== "NONE"
      ? milestoneAmounts(depositBaseCents ?? 0, planTemplate(initialPlan(offer), settings, mode), mode).map((m) => ({
          label: m.label,
          percentBps: m.percentBps,
          amountCents: m.amountCents,
          triggerText: m.triggerText,
          status: "PENDING",
          dueDate: null,
        }))
      : [];
  const validUntil = isQuote ? (input.validUntil ?? defaultQuoteValidUntil(now)) : input.validUntil;

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
    billingMode: mode,
    offeredIntervals: isQuote ? (input.offeredIntervals ?? null) : null,
    paymentScheduleSnapshot: null,
    ...(isQuote ? (input.recurringDiscount ?? NO_RECURRING_DISCOUNT) : NO_RECURRING_DISCOUNT),
    promoCode: isQuote ? (input.promoCode ?? null) : null,
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
    scopeSnapshot: isQuote ? await scopeOf(mode, lines) : null,
    lines,
  } as unknown as Invoice & BuildPdfPayloadInput["invoice"];

  // Propositions : lignes rattachées à chacune, réglages tels que la route les enregistrerait.
  if (isQuote && input.options?.length) {
    const optionLines = input.options.flatMap((o, i) => o.totals.lines.map((l) => ({ ...l, optionId: `apercu-${i}` })));
    Object.assign(invoice, {
      billingMode: null,
      paymentPlanOffer: null,
      depositBaseCents: null,
      milestones: [],
      lines: optionLines,
      scopeSnapshot: null,
      options: await Promise.all(input.options.map(async (o, i) => {
        // Offre et base figées comme à l'émission (seuil du 3 fois, abonnement seul ou sans partie ponctuelle).
        const committedOption = o.totals.lines.filter(isCommittedLine);
        const base = computeDepositBaseCents(committedOption, o.totals.subtotalCents, o.totals.totalCents);
        return {
        id: `apercu-${i}`,
        position: i,
        label: o.label,
        billingMode: o.billingMode,
        paymentPlanOffer: offerAtIssue(o.billingMode, committedOption, base, o.paymentPlanOffer, settings),
        offeredIntervals: o.offeredIntervals ?? null,
        discountType: o.totals.discountType,
        discountValue: o.totals.discountValue,
        ...o.recurringDiscount,
        promoCodeId: o.promoCode?.id ?? null,
        promoCode: o.promoCode ? { code: o.promoCode.code, conditionText: o.promoCode.conditionText } : null,
        subtotalCents: o.totals.subtotalCents,
        totalCents: o.totals.totalCents,
        depositBaseCents: base,
        paymentScheduleSnapshot: null,
        scopeSnapshot: await scopeOf(o.billingMode, o.totals.lines),
        };
      })),
    });
  }

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
  const snapshot = (readClientSnapshot(original) as ClientSnapshot | null) ?? (await buildClientSnapshot(original.clientId));
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
    billingMode: null,
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
