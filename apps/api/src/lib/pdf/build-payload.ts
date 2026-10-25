import { invoiceBalance } from "@/lib/invoices/balance.js";
import type {
  Invoice,
  InvoiceLine,
  Payment,
  PaymentMilestone,
  QuoteAcceptanceAudit,
} from "@prisma/client";
import type { ClientSnapshot } from "@/lib/invoices/transitions.js";
import type { InvoicePdfData } from "@/lib/pdf/invoice-document.js";
import { clausesForClient, DEDICATED_CLAUSE_KINDS, type ClauseText } from "@/lib/company/legal-clauses.js";
import {
  describePlans,
  planSettingsOf,
  parsePaymentPlan,
  parseBillingMode,
  parsePaymentPlanOffer,
  isSubscriptionOnly,
  type PlanSettings,
} from "@/lib/quotes/payment-plans.js";
import { startFromPhrase, startPhrase } from "@/lib/subscriptions/start.js";
import { recurringDiscountSummary } from "@/lib/quotes/recurring-discount.js";
import { normalizeInterval, periodMonths } from "@/lib/subscriptions/subscription-service.js";
import { billedWithDocument } from "@/lib/invoices/totals.js";

type InvoiceWithRelations = Invoice & {
  lines: InvoiceLine[];
  payments?: Payment[];
  /** Avoirs émis sur la facture (et leurs remboursements) : reste dû du rendu de secours. */
  creditNotes?: Array<{ totalCents: number; payments?: Array<{ amountCents: number }> }>;
  creditedInvoice?: { number: string | null; issueDate: Date | null } | null;
  /** Code promo du devis (R3). */
  promoCode?: { code: string; conditionText: string | null } | null;
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
  legalClauses?: ClauseText[];
  /** Type du client du document (instantané à l'émission) : filtre les clauses B2B ou B2C. */
  clientType: string | null;
  balanceSummary?: BalanceSummary | null;
  /** Réglages des formules : tableaux « au choix » d'un devis non encore signé. */
  planSettings?: PlanSettings | null;
  /** CGV publiées (réglages) : lien et version imprimés sur le devis. */
  cgv?: { published: boolean; url: string | null; version: string | null } | null;
};

/** Réglages lus par le PDF d'un document : formules de paiement et CGV publiées. */
export async function pdfSettingsOf(): Promise<Pick<BuildPdfPayloadInput, "planSettings" | "cgv">> {
  const { getCompanySettings } = await import("@/lib/company.js");
  const s = await getCompanySettings();
  return { planSettings: s, cgv: { published: s.cgvPublished, url: s.cgvUrl, version: s.cgvVersion } };
}

const PLAN_TITLE = { ONE: "Paiement comptant", TWO: "Paiement en 2 fois", THREE: "Paiement en 3 fois" } as const;

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
  clientType,
  balanceSummary,
  planSettings,
  cgv,
}: BuildPdfPayloadInput): InvoicePdfData["invoice"] {
  const offer = parsePaymentPlanOffer(invoice.paymentPlanOffer);
  const clauses = clausesForClient(legalClauses ?? [], clientType);
  const clauseBody = (kind: string) => clauses.find((c) => c.kind === kind)?.body ?? null;
  const proof = invoice.quoteAcceptanceAudits?.[0];
  // Devis signé en ligne : la version acceptée ; sinon la version en vigueur, si publiée.
  const cgvShown =
    proof?.cgvAccepted && proof.cgvUrl && proof.cgvVersion
      ? { url: proof.cgvUrl, version: proof.cgvVersion }
      : cgv?.published && cgv.url && cgv.version
        ? { url: cgv.url, version: cgv.version }
        : null;
  const retained = parsePaymentPlan(invoice.paymentPlan);
  const isQuote = invoice.documentType === "QUOTE";
  const fromDelivery = Boolean(
    isQuote && offer !== "NONE" && invoice.depositBaseCents !== null && invoice.lines.some((l) => l.isSubscription),
  );
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
        ? describePlans(offer, invoice.depositBaseCents ?? invoice.totalCents, planSettingsOf(invoice, planSettings), parseBillingMode(invoice.billingMode)).map((p) => ({
            title: PLAN_TITLE[p.plan],
            milestones: p.milestones,
          }))
        : null,
    paymentPlanRetained: isQuote && offer && retained ? PLAN_TITLE[retained] : null,
    subscriptionOnly: isQuote && (offer === "NONE" || isSubscriptionOnly(invoice.lines)),
    // Devis mixte : l'abonnement démarre à la livraison, hors échéancier.
    subscriptionFromDelivery: fromDelivery,
    // Devis mixte : total du projet (partie ponctuelle remisée, base de l'acompte) et abonnements à part.
    // Devis récurrent (mode de facturation) : frais à la signature puis l'abonnement, au lieu du « total du projet ».
    recurringSummary: isQuote && parseBillingMode(invoice.billingMode) === "RECURRING" ? recurringSummaryOf(invoice) : null,
    mixedTotals: fromDelivery && parseBillingMode(invoice.billingMode) !== "RECURRING"
      ? (() => {
          const oneOffCents = invoice.lines.filter((l) => !l.isSubscription).reduce((s, l) => s + l.lineTotalCents, 0);
          const subs = invoice.lines.filter((l) => l.isSubscription);
          const sum = (iv: "YEAR" | "MONTH") =>
            subs.filter((l) => (l.billingInterval === "YEAR" ? "YEAR" : "MONTH") === iv).reduce((s, l) => s + l.unitPriceCents, 0);
          return {
            oneOffCents,
            discountCents: Math.max(0, invoice.subtotalCents - invoice.totalCents),
            projectCents: invoice.depositBaseCents ?? 0,
            subscriptions: subs.map((l) => ({
              label: l.description,
              text: startPhrase(l, true, l.unitPriceCents, normalizeInterval(l.billingInterval)),
            })),
            yearCents: sum("YEAR"),
            monthCents: sum("MONTH"),
          };
        })()
      : null,
    balanceSummary: balanceSummary ?? null,
    milestones: invoice.milestones.map((m) => ({
      label: m.label,
      percentBps: m.percentBps,
      amountCents: m.amountCents,
      triggerText: m.triggerText,
      status: MILESTONE_STATUS_LABEL[m.status] ?? m.status,
      dueDate: m.dueDate,
    })),
    ...(invoice.creditNotes?.length
      ? (() => {
          const b = invoiceBalance({ totalCents: invoice.totalCents, payments: invoice.payments ?? [], creditNotes: invoice.creditNotes });
          return { creditedCents: b.creditedCents, refundedCents: b.refundedCents };
        })()
      : {}),
    payments: (invoice.payments ?? []).map((p) => ({
      paidAt: p.paidAt,
      amountCents: p.amountCents,
      method: PAYMENT_METHOD_LABEL[p.method] ?? p.method,
      reference: p.reference,
      status: invoice.status === "PAID" ? "Payé" : "Enregistré",
    })),
    // Abonnement à 1re facture repoussée : hors du tableau et du total, seulement dans l'engagement d'abonnement.
    lines: invoice.lines.map((l) => ({
      inTotal: billedWithDocument(l),
      description: l.description,
      quantity: Number(l.quantity),
      unitPriceCents: l.unitPriceCents,
      lineTotalCents: l.lineTotalCents,
      isSubscription: l.isSubscription,
      billingDay: l.billingDay,
      billingInterval: l.billingInterval,
      groupTitle: l.groupTitle,
      isPackDiscount: l.isPackDiscount,
      commitmentMonths: l.isSubscription ? (l.commitmentMonths ?? null) : null,
      // Départ choisi sur la ligne du devis (date précise, mois offerts…) : phrase à la place du départ par défaut.
      startText:
        isQuote && l.isSubscription && l.subscriptionStart
          ? startPhrase(
              l,
              // Mode récurrent : pas de projet hors départ « à la livraison » choisi (comme recurringSummaryOf).
              parseBillingMode(invoice.billingMode) === "RECURRING" ? l.subscriptionStart === "DELIVERY" : fromDelivery,
              l.unitPriceCents,
              normalizeInterval(l.billingInterval),
            )
          : null,
    })),
    // Clause de cession (R2) : seulement sur le devis de rachat d'un abonnement.
    legalClauses: clauses
      .filter((c) => !DEDICATED_CLAUSE_KINDS.has(c.kind))
      .filter((c) => c.kind !== "BUYOUT_TRANSFER" || (invoice.documentType === "QUOTE" && Boolean(invoice.buysOutSubscriptionId)))
      .map((c) => ({ title: c.title, body: c.body })),
    subscriptionTerms: {
      MONTH: clauseBody("SUBSCRIPTION_MONTHLY"),
      YEAR: clauseBody("SUBSCRIPTION_ANNUAL"),
      QUARTER: clauseBody("SUBSCRIPTION_QUARTERLY"),
      COMMITMENT: clauseBody("SUBSCRIPTION_COMMITMENT"),
    },
    // Information précontractuelle des particuliers (audience B2C) : devis seulement.
    withdrawalTerms: isQuote ? clauseBody("WITHDRAWAL") : null,
    subscriptionDateNotice: isQuote && invoice.lines.some((l) => l.isSubscription) ? clauseBody("SUBSCRIPTION_BILLING_DATE") : null,
    cgv: isQuote ? cgvShown : null,
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
  const terms = audit
    ? {
        cgvAccepted: audit.cgvAccepted,
        consumer: audit.consumer,
        expressExecution: audit.expressExecution,
        withdrawalEndsAt: audit.withdrawalEndsAt,
      }
    : {};
  if (!audit?.signatureMode) return { signerName, acceptedAt, ...terms };
  return {
    signerName,
    acceptedAt,
    ...terms,
    company: audit.signerCompany,
    mode: audit.signatureMode === "DRAWN" ? "DRAWN" : "TYPED",
    image: audit.signatureImage,
    emailMasked: audit.verifiedEmailMasked,
    // Session /suivi : identité confirmée à la connexion (heure du code de connexion), pas par un code de signature.
    sessionLoginAt: audit.authMethod === "PORTAL_SESSION" ? audit.codeVerifiedAt : null,
    proofId: audit.id,
    documentSha256: audit.originalPdfSha256,
  };
}

export type { ClientSnapshot };

/**
 * Devis récurrent : l'abonnement, un seul pour le devis (lignes additionnées), sans frais de mise en service ; total
 * sur la durée de l'engagement (contrat /suivi F5).
 */
function recurringSummaryOf(invoice: InvoiceWithRelations) {
  const subs = invoice.lines.filter((l) => l.isSubscription);
  const first = subs[0];
  if (!first) return null;
  const period = normalizeInterval(first.billingInterval);
  const amountCents = subs.reduce((sum, l) => sum + l.unitPriceCents, 0);
  const months = first.commitmentMonths ?? null;
  const periods = months ? Math.ceil(months / periodMonths(period)) : null;
  const discount = recurringDiscountSummary(invoice, amountCents, period, months);
  return {
    period,
    amountCents,
    commitmentMonths: months,
    periods,
    totalCommitmentCents: discount?.totalCommitmentCents ?? (periods ? amountCents * periods : null),
    discount,
    startText: startPhrase(first, first.subscriptionStart === "DELIVERY", amountCents, period),
    startFromText: startFromPhrase(first, first.subscriptionStart === "DELIVERY"),
    billingDay: first.billingDay,
  };
}
