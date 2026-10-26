import { assertMediatorFor } from "@/lib/company/mediator.js";
import { listActiveLegalClauses, snapshotOfClauses } from "@/lib/company/legal-clauses.js";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
  QuoteStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { archiveIssuedDocument } from "@/lib/pdf/issued-archive.js";
import { assertQuoteSigned } from "@/lib/invoices/workflow.js";
import { getCompanySettings } from "@/lib/company.js";
import { allocateInvoiceNumber, allocateQuoteNumber } from "@/lib/invoices/numberingService.js";
import { ensureQuoteMilestones } from "@/lib/quotes/milestones.js";
import { startAfterWithdrawal, withdrawalEndsAt } from "@/lib/quotes/withdrawal.js";
import { billedWithDocument, computeDepositBaseCents, depositBaseOf } from "@/lib/invoices/totals.js";
import {
  applyPlanMilestones,
  effectiveOffer,
  initialPlan,
  isSubscriptionOnly,
  parseBillingMode,
  parsePaymentPlanOffer,
  planSettingsOf,
  scheduleSnapshotOf,
  PaymentPlanError,
  resolveAcceptedPlan,
  type PaymentPlan,
} from "@/lib/quotes/payment-plans.js";
import { assertBillingModeLines } from "@/lib/quotes/billing-mode.js";
import { resolveRecurringDiscount, storedRecurringDiscount } from "@/lib/quotes/recurring-discount.js";
import { assertPromoCodeApplicable } from "@/lib/quotes/promo-codes.js";
import { BILLABLE_LINES_WHERE, proposalLetter, quoteFieldsOfOption } from "@/lib/quotes/quote-options.js";
import {
  buildClientSnapshot,
  type ClientSnapshot,
  generateMilestoneInvoice,
  generateBalanceInvoice,
  syncMilestoneOnInvoicePaid,
  assertQuoteEditable,
  DocumentFlowError,
} from "@/lib/invoices/documentFlowService.js";
import {
  activateSubscriptionsFromDocument,
  shiftRevisedPeriod,
  notifyStripeSubscriptionSetup,
} from "@/lib/subscriptions/activate-from-document.js";
import { activationPoint } from "@/lib/subscriptions/start.js";

export type { ClientSnapshot };
export {
  generateMilestoneInvoice,
  generateBalanceInvoice,
  syncMilestoneOnInvoicePaid,
  assertQuoteEditable,
  DocumentFlowError,
};
export {
  assessCreditNoteEligibility,
  createCreditNote,
  cancelInvoiceWithCreditNote,
  CreditNoteError,
} from "@/lib/invoices/credit-note-service.js";

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Émission d'une facture dans une transaction fournie.
 * L'activation des abonnements en fait partie : une facture émise dont
 * l'abonnement n'a pas pu être créé laisserait un numéro légal consommé
 * pour rien.
 */
export async function issueInvoiceWithin(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  issueDate: Date,
  dueDate: Date | undefined,
  settings: Awaited<ReturnType<typeof getCompanySettings>>,
) {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { lines: true },
  });

  if (invoice.status !== InvoiceStatus.DRAFT) {
    throw new Error("Seuls les brouillons peuvent être émis");
  }
  if (invoice.lines.length === 0) {
    throw new Error("Impossible d'émettre une facture sans lignes");
  }
  if (invoice.documentType !== InvoiceDocumentType.INVOICE) {
    throw new Error("Document invalide pour émission de facture");
  }

  const allocated = await allocateInvoiceNumber(issueDate, tx);
  const snapshot = await buildClientSnapshot(invoice.clientId, tx);

  const updated = await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      status: InvoiceStatus.ISSUED,
      number: allocated.number,
      sequenceYear: allocated.sequenceYear,
      sequenceNumber: allocated.sequenceNumber,
      issueDate,
      dueDate: dueDate ?? issueDate,
      issuedAt: new Date(),
      clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      // Facture miroir d'une échéance Stripe : Stripe retente et l'ERP écrit sur échec, pas de relance.
      nextReminderAt: invoice.stripeInvoiceId ? null : addDays(dueDate ?? issueDate, settings.reminderInvoiceDays),
    },
    include: { lines: true, client: true, payments: true },
  });

  const subs = await activateSubscriptionsFromDocument(invoiceId, tx);
  return { ...updated, subscriptionsCreated: subs.created };
}

export async function issueInvoice(invoiceId: string, issueDate = new Date(), dueDate?: Date) {
  const settings = await getCompanySettings();
  const issued = await prisma.$transaction((tx) =>
    issueInvoiceWithin(tx, invoiceId, issueDate, dueDate, settings),
  );
  await archiveIssuedDocument(invoiceId);
  const lines = await prisma.invoiceLine.findMany({
    where: { invoiceId, subscriptionId: { not: null } },
    select: { subscriptionId: true },
  });
  await notifyStripeSubscriptionSetup(
    lines.map((l) => l.subscriptionId!).filter(Boolean),
  );
  return issued;
}

/** Émet un devis (numéro D-YYYY-NNN, QuoteStatus SENT) et crée les jalons acompte / solde. */

export async function issueQuote(
  quoteId: string,
  issueDate = new Date(),
  validUntil?: Date,
) {
  const settings = await getCompanySettings();
  // Clauses figées à l'émission (décision du 23/10/2026) : un devis régénéré imprime toujours les clauses d'origine.
  const activeClauses = await listActiveLegalClauses();
  const updated = await prisma.$transaction(async (tx) => {
    const quote = await tx.invoice.findUniqueOrThrow({
      where: { id: quoteId },
      include: { lines: true, options: { orderBy: { position: "asc" } } },
    });

    if (quote.documentType !== InvoiceDocumentType.QUOTE) {
      throw new Error("Ce document n'est pas un devis");
    }
    if (quote.status !== InvoiceStatus.DRAFT) {
      throw new Error("Seuls les brouillons de devis peuvent être émis");
    }
    if (quote.lines.length === 0) {
      throw new Error("Impossible d'émettre un devis sans lignes");
    }
    // Devis à propositions : chacune vérifiée comme un devis (mode, remise, code promo) et figée ; le devis reste neutre.
    const frozenOptions = [];
    for (const o of quote.options) {
      const lines = quote.lines.filter((l) => l.optionId === o.id);
      if (lines.length === 0) throw new Error(`Proposition ${proposalLetter(o)} : aucune ligne.`);
      const optionMode = parseBillingMode(o.billingMode);
      assertBillingModeLines(optionMode, lines);
      resolveRecurringDiscount(optionMode, lines, { recurringDiscount: storedRecurringDiscount(o), openingDiscount: o.openingDiscount });
      if (o.promoCodeId) {
        const code = await tx.promoCode.findUniqueOrThrow({ where: { id: o.promoCodeId } });
        await assertPromoCodeApplicable(code, { id: quote.id, clientId: quote.clientId, serviceIds: lines.filter((l) => l.isSubscription).map((l) => l.serviceId) }, issueDate, tx);
      }
      const base = computeDepositBaseCents(lines, o.subtotalCents, o.totalCents);
      const noOneOff = lines.some((l) => l.isSubscription) && base <= 0;
      const optionOffer =
        optionMode === "RECURRING" || isSubscriptionOnly(lines) || noOneOff ? "NONE" : effectiveOffer(parsePaymentPlanOffer(o.paymentPlanOffer), base, settings);
      frozenOptions.push({ id: o.id, depositBaseCents: base, paymentPlanOffer: optionOffer });
    }
    const withOptions = frozenOptions.length > 0;
    // Brouillon antérieur à une règle du mode (engagement obligatoire en récurrent) : bloqué avant numérotation.
    if (!withOptions) assertBillingModeLines(parseBillingMode(quote.billingMode), quote.lines);
    // Remise du devis récurrent (R1) revérifiée sur les lignes émises (ex. remise d'ouverture sans engagement de 36 mois).
    if (!withOptions) resolveRecurringDiscount(parseBillingMode(quote.billingMode), quote.lines, { recurringDiscount: storedRecurringDiscount(quote), openingDiscount: quote.openingDiscount });
    // Code promo (R3) revérifié à l'émission : actif, valable ce jour, offres, usages restants, un usage par client.
    if (quote.promoCodeId) {
      const code = await tx.promoCode.findUniqueOrThrow({ where: { id: quote.promoCodeId } });
      await assertPromoCodeApplicable(code, { id: quote.id, clientId: quote.clientId, serviceIds: quote.lines.filter((l) => l.isSubscription).map((l) => l.serviceId) }, issueDate, tx);
    }
    // Émis = signable en ligne : un particulier exige un médiateur de la consommation déclaré (L612-1).
    const client = await tx.client.findUniqueOrThrow({ where: { id: quote.clientId }, select: { type: true } });
    assertMediatorFor(client.type, settings);
    const legalClausesSnapshot = snapshotOfClauses(activeClauses, client.type, settings.vatMention);

    const allocated = await allocateQuoteNumber(issueDate, tx);
    const snapshot = await buildClientSnapshot(quote.clientId, tx);
    const validity =
      validUntil ??
      new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    // Offre de paiement figée à l'émission (seuil du 3 fois appliqué ici). Abonnement seul :
    // pas d'échéancier, chaque période est facturée par l'abonnement.
    // Base de l'acompte, du 2 ou 3 fois et du seuil : la partie ponctuelle (l'abonnement est
    // facturé à chaque période, il n'entre pas dans l'échéancier).
    const depositBaseCents = computeDepositBaseCents(quote.lines, quote.subtotalCents, quote.totalCents);
    // Partie ponctuelle nulle (pack tout en abonnement, remise totale) : comme un abonnement seul, pas d'échéancier à 0 €.
    const noOneOffPart = quote.lines.some((l) => l.isSubscription) && depositBaseCents <= 0;
    // Mode récurrent : abonnement seul (aucune ligne ponctuelle), pas d'échéancier.
    const mode = parseBillingMode(quote.billingMode);
    const offer =
      mode === "RECURRING"
        ? "NONE"
        : isSubscriptionOnly(quote.lines) || noOneOffPart
          ? "NONE"
          : effectiveOffer(parsePaymentPlanOffer(quote.paymentPlanOffer), depositBaseCents, settings);

    const updated = await tx.invoice.update({
      where: { id: quoteId },
      data: {
        status: InvoiceStatus.ISSUED,
        quoteStatus: QuoteStatus.SENT,
        number: allocated.number,
        sequenceYear: allocated.sequenceYear,
        sequenceNumber: allocated.sequenceNumber,
        issueDate,
        validUntil: validity,
        dueDate: validity,
        issuedAt: new Date(),
        clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        legalClausesSnapshot: legalClausesSnapshot as unknown as Prisma.InputJsonValue,
        // Échéancier figé à l'émission : la signature, le PDF et les dates d'échéance le relisent.
        paymentScheduleSnapshot: scheduleSnapshotOf(settings),
        nextReminderAt: addDays(issueDate, settings.reminderQuoteDays),
        // Devis à propositions : offre et base portées par chaque proposition, recopiées sur le devis à la signature.
        paymentPlanOffer: withOptions ? null : offer,
        depositBaseCents: withOptions ? null : depositBaseCents,
        // Émis : le devis préparé hors ligne a été relu.
        offlineReviewReason: null,
      },
      include: { lines: true, client: true, payments: true },
    });

    // Jalons créés pendant le brouillon (affichage de la fiche, offre encore 2 fois) : retirés,
    // un devis d'abonnement seul n'en a aucun. Un brouillon n'a jamais de jalon payé ni facturé.
    if (withOptions) {
      // L'échéancier dépend de la proposition retenue : créé à la signature, aucun jalon d'ici là.
      for (const f of frozenOptions) {
        await tx.quoteOption.update({
          where: { id: f.id },
          data: { depositBaseCents: f.depositBaseCents, paymentPlanOffer: f.paymentPlanOffer, paymentScheduleSnapshot: scheduleSnapshotOf(settings) },
        });
      }
      await tx.paymentMilestone.deleteMany({ where: { quoteId, invoiceId: null } });
      return updated;
    }
    if (offer === "NONE") await tx.paymentMilestone.deleteMany({ where: { quoteId, invoiceId: null } });
    if (offer === null) await ensureQuoteMilestones(quoteId, depositBaseCents, tx);
    else if (offer !== "NONE") await applyPlanMilestones(tx, quoteId, depositBaseCents, initialPlan(offer), settings, { mode });
    return updated;
  });

  return updated;
}

/**
 * Attribue un numéro officiel D-YYYY-NNN à un devis qui n'en a pas encore
 * (acceptation ou conversion sans émission préalable).
 */
export async function ensureQuoteHasOfficialNumber(
  tx: Prisma.TransactionClient,
  quoteId: string,
  issueDate = new Date(),
) {
  const quote = await tx.invoice.findUniqueOrThrow({ where: { id: quoteId } });
  if (quote.documentType !== InvoiceDocumentType.QUOTE || quote.number) {
    return quote;
  }

  const allocated = await allocateQuoteNumber(issueDate, tx);
  const snapshot = await buildClientSnapshot(quote.clientId, tx);
  const patch: Prisma.InvoiceUpdateInput = {
    number: allocated.number,
    sequenceYear: allocated.sequenceYear,
    sequenceNumber: allocated.sequenceNumber,
    issueDate: quote.issueDate ?? issueDate,
    issuedAt: quote.issuedAt ?? new Date(),
    clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
  };
  if (quote.status === InvoiceStatus.DRAFT) {
    patch.status = InvoiceStatus.ISSUED;
  }
  if (quote.quoteStatus === QuoteStatus.DRAFT) {
    patch.quoteStatus = QuoteStatus.SENT;
  }

  return tx.invoice.update({
    where: { id: quoteId },
    data: patch,
    include: { lines: true, client: true },
  });
}

/** Répare les devis sans numéro (données antérieures à la correction). */
export async function repairQuotesMissingNumbers(): Promise<number> {
  const quotes = await prisma.invoice.findMany({
    where: {
      documentType: InvoiceDocumentType.QUOTE,
      number: null,
      status: { not: InvoiceStatus.CANCELLED },
    },
    select: { id: true },
  });
  for (const q of quotes) {
    await prisma.$transaction((tx) => ensureQuoteHasOfficialNumber(tx, q.id));
  }
  return quotes.length;
}

/** Erreur métier sur une décision de devis (refus, acceptation en ligne). */
export class QuoteDecisionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "NOT_A_QUOTE"
      | "NOT_PENDING"
      | "ALREADY_INVOICED"
      | "DEPOSIT_REQUIRED"
      | "EXPIRED"
      | "OPTION_REQUIRED"
      | "OPTION_INVALID",
  ) {
    super(message);
    this.name = "QuoteDecisionError";
  }
}

export type QuoteAcceptanceSource = "PORTAL" | "THREAD" | "ADMIN";

export type QuoteAcceptanceActor = {
  userId?: string | null;
  userEmail?: string | null;
};

/** Contexte technique du signataire (portail) conservé comme preuve. */
export type QuoteAcceptanceContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Signature depuis l'espace client, confirmée par un code envoyé par e-mail. */
/** Conditions de la signature, figées dans la preuve (jamais modifiées ensuite). */
export type QuoteSignatureTerms = {
  cgvAccepted: boolean;
  cgvUrl: string | null;
  cgvVersion: string | null;
  consumer: boolean;
  expressExecution: boolean | null;
  withdrawalEndsAt: Date | null;
};

export type QuoteSignature = {
  mode: "TYPED" | "DRAWN";
  /** Tracé PNG (data URL), mode DRAWN seulement */
  image?: string | null;
  /** Société représentée (client professionnel) */
  company?: string | null;
  emailMasked?: string | null;
  /** SIGN_CODE : code de signature de ce devis. PORTAL_SESSION : session /suivi ouverte par le code de connexion. */
  authMethod: "SIGN_CODE" | "PORTAL_SESSION";
  /** Heure de vérification du code : de signature, ou de connexion à /suivi (ouverture de la session). */
  codeVerifiedAt: Date;
};

async function logQuoteAcceptance(
  db: Prisma.TransactionClient,
  quoteId: string,
  signerName: string,
  source: QuoteAcceptanceSource,
  opts: {
    threadId?: string | null;
    actor?: QuoteAcceptanceActor;
    context?: QuoteAcceptanceContext;
    signature?: QuoteSignature;
    originalPdfSha256?: string | null;
    paymentPlan?: PaymentPlan | null;
    terms?: QuoteSignatureTerms;
    option?: { id: string; label: string; totalCents: number } | null;
  } = {},
) {
  return db.quoteAcceptanceAudit.create({
    data: {
      quoteId,
      signerName: signerName.trim(),
      source,
      threadId: opts.threadId ?? null,
      userId: opts.actor?.userId ?? null,
      userEmail: opts.actor?.userEmail ?? null,
      ipAddress: opts.context?.ipAddress?.slice(0, 64) || null,
      userAgent: opts.context?.userAgent?.slice(0, 512) || null,
      signatureMode: opts.signature?.mode ?? null,
      signatureImage: opts.signature?.image ?? null,
      signerCompany: opts.signature?.company ?? null,
      verifiedEmailMasked: opts.signature?.emailMasked ?? null,
      codeVerifiedAt: opts.signature?.codeVerifiedAt ?? null,
      authMethod: opts.signature?.authMethod ?? null,
      originalPdfSha256: opts.originalPdfSha256 ?? null,
      paymentPlan: opts.paymentPlan ?? null,
      cgvAccepted: opts.terms?.cgvAccepted ?? null,
      cgvUrl: opts.terms?.cgvUrl ?? null,
      cgvVersion: opts.terms?.cgvVersion ?? null,
      consumer: opts.terms?.consumer ?? null,
      expressExecution: opts.terms?.expressExecution ?? null,
      withdrawalEndsAt: opts.terms?.withdrawalEndsAt ?? null,
      optionId: opts.option?.id ?? null,
      optionLabel: opts.option?.label ?? null,
      optionTotalCents: opts.option?.totalCents ?? null,
    },
  });
}

/**
 * Conditions d'une signature. CGV : acceptées seulement en ligne (espace client) et publiées.
 * Consommateur (client B2C) : délai de rétractation de 14 jours ; sans demande d'exécution
 * anticipée (possible seulement en ligne), rien ne démarre avant sa fin (CGV art. 9.4, 9.5).
 */
export function signatureTerms(input: {
  source: QuoteAcceptanceSource;
  clientType: string | null | undefined;
  signedAt: Date;
  settings: { cgvPublished: boolean; cgvUrl: string | null; cgvVersion: string | null };
  cgvAccepted?: boolean;
  expressExecution?: boolean;
}): QuoteSignatureTerms {
  const online = input.source === "PORTAL";
  const cgvAccepted = online && input.settings.cgvPublished && input.cgvAccepted === true;
  const consumer = input.clientType === "B2C";
  return {
    cgvAccepted,
    cgvUrl: cgvAccepted ? input.settings.cgvUrl : null,
    cgvVersion: cgvAccepted ? input.settings.cgvVersion : null,
    consumer,
    expressExecution: consumer ? online && input.expressExecution === true : null,
    withdrawalEndsAt: consumer ? withdrawalEndsAt(input.signedAt) : null,
  };
}

/** Début au plus tôt des travaux et de l'abonnement : null si rien n'est à différer. */
export function deferredStartOf(terms: Pick<QuoteSignatureTerms, "consumer" | "expressExecution" | "withdrawalEndsAt">): Date | null {
  if (!terms.consumer || terms.expressExecution || !terms.withdrawalEndsAt) return null;
  return startAfterWithdrawal(terms.withdrawalEndsAt);
}

/**
 * Charge un devis en attente de décision client.
 * Un devis déjà facturé n'est plus décidable : la décision commerciale est actée.
 */
async function loadPendingQuote(tx: Prisma.TransactionClient, quoteId: string, opts: { refuseExpired?: boolean } = {}) {
  const quote = await tx.invoice.findUniqueOrThrow({ where: { id: quoteId } });

  if (quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new QuoteDecisionError("Ce document n'est pas un devis", "NOT_A_QUOTE");
  }
  if (quote.quoteStatus !== QuoteStatus.SENT) {
    throw new QuoteDecisionError(
      "Seul un devis envoyé et encore en attente peut être accepté ou refusé",
      "NOT_PENDING",
    );
  }
  // Validité dépassée : même règle que le passage en « Expiré » par le worker, sans attendre son passage.
  if (opts.refuseExpired && quote.validUntil && quote.validUntil < new Date()) {
    throw new QuoteDecisionError("Ce devis n'est plus valable : demandez un nouveau devis.", "EXPIRED");
  }

  const invoiced = await tx.invoice.count({
    where: {
      quoteId,
      documentType: InvoiceDocumentType.INVOICE,
      status: { not: InvoiceStatus.CANCELLED },
    },
  });
  if (invoiced > 0) {
    throw new QuoteDecisionError(
      "Ce devis a déjà donné lieu à une facture",
      "ALREADY_INVOICED",
    );
  }

  return quote;
}

/** Refuse un devis envoyé : le document est clos, aucune facture ne pourra en découler. */
export async function rejectQuote(quoteId: string, reason?: string) {
  return prisma.$transaction(async (tx) => {
    await loadPendingQuote(tx, quoteId);
    return tx.invoice.update({
      where: { id: quoteId },
      data: {
        quoteStatus: QuoteStatus.REJECTED,
        status: InvoiceStatus.CANCELLED,
        quoteDecidedAt: new Date(),
        quoteRejectReason: reason?.trim() || null,
      },
      include: { lines: true, client: true },
    });
  });
}

/**
 * Acceptation d'un devis par le client depuis le portail de suivi.
 * Le nom saisi vaut bon pour accord. La facture reste à émettre par le dirigeant.
 */
export async function acceptQuoteByClient(
  quoteId: string,
  signerName: string,
  audit: {
    source?: QuoteAcceptanceSource;
    threadId?: string | null;
    actor?: QuoteAcceptanceActor;
    context?: QuoteAcceptanceContext;
    signature?: QuoteSignature;
    /** Formule de paiement choisie (offre CHOICE : obligatoire depuis l'espace client). */
    paymentPlan?: PaymentPlan | null;
    /** Espace client : CGV acceptées (case cochée, version contrôlée par la route). */
    cgvAccepted?: boolean;
    /** Espace client, consommateur : exécution demandée avant la fin du délai de rétractation. */
    expressExecution?: boolean;
    /** Devis à propositions : la proposition retenue (obligatoire). */
    optionId?: string | null;
  } = {},
) {
  const options = await prisma.quoteOption.findMany({ where: { quoteId }, orderBy: { position: "asc" } });
  const option = options.length ? (options.find((o) => o.id === audit.optionId) ?? null) : null;
  if (options.length && !audit.optionId) throw new QuoteDecisionError("Choisissez l'une des propositions du devis.", "OPTION_REQUIRED");
  if ((options.length && !option) || (!options.length && audit.optionId)) {
    throw new QuoteDecisionError("Cette proposition n'existe pas sur ce devis.", "OPTION_INVALID");
  }
  // Formule retenue, validée avant toute écriture.
  const pending = await prisma.invoice.findUniqueOrThrow({
    where: { id: quoteId },
    select: {
      paymentScheduleSnapshot: true,
      paymentPlanOffer: true,
      billingMode: true,
      totalCents: true,
      depositBaseCents: true,
      lines: { select: { id: true, optionId: true, isSubscription: true, subscriptionStart: true, subscriptionStartDate: true, subscriptionFreeMonths: true } },
      client: { select: { type: true } },
    },
  });
  // Devis à propositions : la proposition retenue tient lieu de devis (offre, mode, base, lignes).
  if (option) Object.assign(pending, quoteFieldsOfOption(option), { lines: pending.lines.filter((l) => l.optionId === option.id) });
  const offer = parsePaymentPlanOffer(pending.paymentPlanOffer);
  // Devis mixte : l'abonnement démarre à la livraison (projet terminé), pas à la signature.
  const deferSubscription = isDeferredSubscriptionQuote(pending);
  const plan =
    offer === null
      ? null
      : resolveAcceptedPlan(offer, audit.paymentPlan, { requireChoice: (audit.source ?? "PORTAL") === "PORTAL" });
  if (offer === null && audit.paymentPlan && audit.paymentPlan !== "TWO") {
    throw new PaymentPlanError("Cette formule de paiement n'est pas proposée sur ce devis.");
  }
  const settings = await getCompanySettings();
  const subscriptionOnly = offer === "NONE";
  const terms = signatureTerms({
    source: audit.source ?? "PORTAL",
    clientType: pending.client.type,
    signedAt: new Date(),
    settings,
    cgvAccepted: audit.cgvAccepted,
    expressExecution: audit.expressExecution,
  });
  // Abonnement seul d'un consommateur sans demande expresse : 1re période au lendemain du délai.
  const subscriptionStart = deferredStartOf(terms);

  // Signature portail : on fige le devis tel que le client l'a lu, avant qu'il porte l'accord.
  const { captureQuoteBeforeSignature, archiveOriginalQuote } = await import(
    "@/lib/invoices/acceptance-proof.js"
  );
  const original = audit.signature ? await captureQuoteBeforeSignature(quoteId) : null;
  // Rachat (R2) : import tardif, le module dépend du service d'abonnement qui dépend de celui-ci.
  const { applyBuyoutSignature, finishBuyoutSignature } = await import("@/lib/subscriptions/buyout.js");

  const updated = await prisma.$transaction(async (tx) => {
    await loadPendingQuote(tx, quoteId, { refuseExpired: (audit.source ?? "PORTAL") !== "ADMIN" });
    await ensureQuoteHasOfficialNumber(tx, quoteId);
    // Avant toute facturation : seules les lignes de la proposition retenue deviennent facturables (BILLABLE_LINES_WHERE).
    if (option) await tx.invoice.update({ where: { id: quoteId }, data: { ...quoteFieldsOfOption(option), selectedOptionId: option.id } });
    const result = await tx.invoice.update({
      where: { id: quoteId },
      data: {
        quoteStatus: QuoteStatus.ACCEPTED,
        quoteDecidedAt: new Date(),
        quoteSignerName: signerName.trim(),
        ...(plan ? { paymentPlan: plan } : {}),
      },
      include: { lines: true, client: true },
    });
    if (plan) await applyPlanMilestones(tx, quoteId, depositBaseOf(pending), plan, planSettingsOf(pending, settings), { keepIssued: true, mode: parseBillingMode(pending.billingMode) });
    // Abonnement seul : la 1re échéance est due tout de suite et facturée par l'abonnement
    // (Stripe après le mandat, sinon facture ERP immédiate), jamais par le devis.
    // Devis mixte : seules les lignes au départ « à la signature » ou « à une date » démarrent maintenant ; les
    // autres attendent la livraison (startDeferredSubscriptions).
    // Mode récurrent : un projet (livraison) seulement avec un départ « à la livraison » choisi ; sinon l'abonnement
    // démarre à la signature, comme un devis d'abonnement seul.
    const recurring = parseBillingMode(pending.billingMode) === "RECURRING";
    const hasProject = (l: { subscriptionStart: string | null }) => !recurring || l.subscriptionStart === "DELIVERY";
    const atSignature = pending.lines.filter((l) => l.isSubscription && activationPoint(l, hasProject(l)) === "SIGNATURE").map((l) => l.id);
    const subs = deferSubscription
      ? atSignature.length
        ? await activateSubscriptionsFromDocument(quoteId, tx, {
            firstPeriodNow: true,
            awaitStripe: settings.moduleStripeEnabled,
            startDate: subscriptionStart ?? undefined,
            onlyLineIds: atSignature,
          })
        : { subscriptionIds: [] as string[], createdIds: [] as string[] }
      : await activateSubscriptionsFromDocument(
          quoteId,
          tx,
          subscriptionOnly
            ? { firstPeriodNow: true, awaitStripe: settings.moduleStripeEnabled, startDate: subscriptionStart ?? undefined }
            : {},
        );
    const buyout = await applyBuyoutSignature(tx, quoteId);
    // Preuve de signature dans la même transaction : jamais de devis accepté sans preuve (audit du 25/10/2026).
    // Seul l'archivage du fichier PDF reste après.
    const acceptance = await logQuoteAcceptance(tx, quoteId, signerName, audit.source ?? "PORTAL", {
      threadId: audit.threadId,
      actor: audit.actor,
      context: audit.context,
      signature: audit.signature,
      originalPdfSha256: original?.sha256 ?? null,
      paymentPlan: plan,
      terms,
      option: option ? { id: option.id, label: `${proposalLetter(option)} : ${option.label}`, totalCents: option.totalCents } : null,
    });
    return { result, subscriptionIds: subs.subscriptionIds, createdIds: subs.createdIds, buyout, acceptance };
  });
  const acceptance = updated.acceptance;
  if (original) await archiveOriginalQuote(acceptance.id, original);
  await finishBuyoutSignature(updated.buyout);
  if (subscriptionOnly || deferSubscription) await startSubscriptionBilling(updated.createdIds, settings.moduleStripeEnabled, subscriptionStart);
  else await notifyStripeSubscriptionSetup(updated.subscriptionIds);
  const accepted = updated.result;

  const { onQuoteAcceptedByClient } = await import(
    "@/lib/payments/milestonePaymentService.js"
  );
  await onQuoteAcceptedByClient(quoteId);

  // Après l'échéancier : le PDF archivé porte les dates d'acompte.
  const { recordQuoteAcceptanceProof } = await import("@/lib/invoices/acceptance-proof.js");
  await recordQuoteAcceptanceProof(acceptance.id, quoteId);

  return accepted;
}

/**
 * Devis d'abonnement seul signé : Stripe actif, le lien de prélèvement part (une fois) et Stripe
 * prélève la 1re période au mandat ; sinon, la 1re facture d'abonnement est émise tout de suite.
 */
/** Devis mixte émis depuis la fonction : base figée, des lignes d'abonnement, pas abonnement seul. */
export function isDeferredSubscriptionQuote(quote: {
  depositBaseCents: number | null;
  paymentPlanOffer: string | null;
  lines: ReadonlyArray<{ isSubscription: boolean }>;
  billingMode?: string | null;
}): boolean {
  if (!quote.lines.some((l) => l.isSubscription)) return false;
  // Mode récurrent : le départ choisi (signature, livraison, date) fait foi.
  if (quote.billingMode === "RECURRING") return true;
  return quote.depositBaseCents !== null && quote.paymentPlanOffer !== "NONE";
}

/**
 * Devis mixte signé : démarre l'abonnement à la livraison (projet terminé) ou à la demande.
 * 1re échéance due tout de suite : lien de prélèvement Stripe (une fois) ou facture immédiate.
 * Idempotent : un abonnement déjà relié aux lignes du devis n'est pas recréé.
 * @returns les abonnements créés.
 */
export async function startDeferredSubscriptions(quoteId: string): Promise<string[]> {
  const quote = await prisma.invoice.findUnique({
    where: { id: quoteId },
    select: { documentType: true, quoteStatus: true, depositBaseCents: true, paymentPlanOffer: true, billingMode: true, lines: { where: BILLABLE_LINES_WHERE } },
  });
  if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE || quote.quoteStatus !== QuoteStatus.ACCEPTED) return [];
  if (!isDeferredSubscriptionQuote(quote)) return [];
  if (quote.lines.filter((l) => l.isSubscription).every((l) => l.subscriptionId)) return [];
  const settings = await getCompanySettings();
  // Livraison avant la fin du délai de rétractation (consommateur sans demande expresse) :
  // la 1re période attend tout de même la fin du délai.
  const proof = await prisma.quoteAcceptanceAudit.findFirst({
    where: { quoteId },
    orderBy: { createdAt: "desc" },
    select: { consumer: true, expressExecution: true, withdrawalEndsAt: true },
  });
  const deferred = proof ? deferredStartOf({ ...proof, consumer: proof.consumer ?? false }) : null;
  const startDate = deferred && deferred.getTime() > Date.now() ? deferred : null;
  const subs = await prisma.$transaction((tx) =>
    activateSubscriptionsFromDocument(quoteId, tx, {
      firstPeriodNow: true,
      awaitStripe: settings.moduleStripeEnabled,
      startDate: startDate ?? undefined,
    }),
  );
  await startSubscriptionBilling(subs.createdIds, settings.moduleStripeEnabled, startDate);
  return subs.createdIds;
}

async function startSubscriptionBilling(
  createdIds: string[],
  stripeEnabled: boolean,
  startDate: Date | null = null,
): Promise<void> {
  if (createdIds.length === 0) return;
  if (stripeEnabled) {
    // Départ différé : le mandat est signé tout de suite, Stripe ne prélève qu'à nextInvoiceAt
    // (trial_end de la session de paiement).
    await notifyStripeSubscriptionSetup(createdIds);
    return;
  }
  // Départ différé sans Stripe : la tâche planifiée facture à nextInvoiceAt.
  if (startDate && startDate.getTime() > Date.now()) return;
  const { invoiceSubscriptionNow } = await import("@/lib/subscriptions/subscription-service.js");
  for (const id of createdIds) {
    try {
      await invoiceSubscriptionNow(id);
    } catch (err) {
      // Le cron reprendra l'échéance (nextInvoiceAt est dépassé) : la signature reste acquise.
      console.error(`[abonnement] 1re facture à la signature : ${id}`, err);
    }
  }
}

/** Validation admin depuis la messagerie (fil lié à un client). */
export async function acceptQuoteFromThread(
  quoteId: string,
  opts: {
    signerName: string;
    threadId: string;
    actor: QuoteAcceptanceActor;
    paymentPlan?: PaymentPlan;
    optionId?: string | null;
  },
) {
  const thread = await prisma.emailThread.findUnique({
    where: { id: opts.threadId },
    select: { clientId: true },
  });
  if (!thread?.clientId) {
    throw new QuoteDecisionError("Fil non rattaché à un client", "NOT_PENDING");
  }

  const quote = await prisma.invoice.findUnique({
    where: { id: quoteId },
    select: { clientId: true, documentType: true, quoteStatus: true },
  });
  if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new QuoteDecisionError("Ce document n'est pas un devis", "NOT_A_QUOTE");
  }
  if (quote.clientId !== thread.clientId) {
    throw new QuoteDecisionError("Ce devis n'appartient pas au client du fil", "NOT_PENDING");
  }

  return acceptQuoteByClient(quoteId, opts.signerName, {
    source: "THREAD",
    threadId: opts.threadId,
    actor: opts.actor,
    paymentPlan: opts.paymentPlan,
    optionId: opts.optionId,
  });
}

/** Transforme un devis émis en brouillon de facture. */
export async function convertQuoteToInvoice(quoteId: string) {
  const { applyBuyoutSignature, finishBuyoutSignature } = await import("@/lib/subscriptions/buyout.js");
  const invoice = await prisma.$transaction(async (tx) => {
    const quote = await tx.invoice.findUniqueOrThrow({
      where: { id: quoteId },
      include: { lines: { where: BILLABLE_LINES_WHERE, orderBy: { position: "asc" } } },
    });

    if (quote.documentType !== InvoiceDocumentType.QUOTE) {
      throw new Error("Seuls les devis peuvent être convertis");
    }
    if (quote.paymentPlanOffer === "NONE") {
      throw new Error(
        "Devis d'abonnement : chaque échéance est facturée par l'abonnement, pas de facture depuis le devis.",
      );
    }
    await assertQuoteSigned(quoteId, tx);
    if (
      quote.quoteStatus !== QuoteStatus.SENT &&
      quote.quoteStatus !== QuoteStatus.DRAFT &&
      quote.status !== InvoiceStatus.ISSUED &&
      quote.status !== InvoiceStatus.DRAFT
    ) {
      throw new Error("Devis non convertible");
    }

    const marketInvoices = await tx.invoice.count({
      where: {
        quoteId,
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: { in: [InvoiceType.ACOMPTE, InvoiceType.SOLDE] },
        status: { not: InvoiceStatus.CANCELLED },
      },
    });
    if (marketInvoices > 0) {
      throw new Error(
        "Ce devis a déjà un marché par acomptes : utilisez les factures d'acompte / solde",
      );
    }

    const existing = await tx.invoice.findFirst({
      where: {
        OR: [{ quoteId }, { sourceQuoteId: quoteId }],
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: { not: InvoiceStatus.CANCELLED },
      },
    });
    if (existing) {
      throw new Error("Ce devis a déjà été converti en facture");
    }

    // Devis mixte : la facture totale porte la partie ponctuelle ; l'abonnement sera facturé à
    // chaque période à partir de la livraison. Devis antérieur à la fonction : tout le devis.
    const deferred = isDeferredSubscriptionQuote(quote);
    // Abonnement à 1re facture repoussée (date, mois offerts) : jamais dans la facture du devis.
    const invoicedLines = deferred ? quote.lines.filter((l) => !l.isSubscription) : quote.lines.filter(billedWithDocument);
    const oneOffSubtotal = invoicedLines.reduce((sum, l) => sum + l.lineTotalCents, 0);
    const invoiceTotal = deferred ? depositBaseOf(quote) : quote.totalCents;
    const created = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SIMPLE,
        status: InvoiceStatus.DRAFT,
        clientId: quote.clientId,
        notes: quote.notes,
        paymentTerms: quote.paymentTerms ?? "Paiement à réception",
        subtotalCents: deferred ? oneOffSubtotal : quote.subtotalCents,
        totalCents: invoiceTotal,
        ...(deferred
          ? oneOffSubtotal > invoiceTotal
            ? { discountType: "FIXED", discountValue: oneOffSubtotal - invoiceTotal }
            : { discountType: "NONE", discountValue: 0 }
          : { discountType: quote.discountType, discountValue: quote.discountValue }),
        quoteId: quote.id,
        sourceQuoteId: quote.id,
        // Rachat (R2) : la facture garde le lien vers l'abonnement racheté.
        buysOutSubscriptionId: quote.buysOutSubscriptionId,
        marketTotalCents: invoiceTotal,
        lines: {
          create: invoicedLines.map((line) => ({
            position: line.position,
            description: line.description,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            lineTotalCents: line.lineTotalCents,
            isSubscription: line.isSubscription,
            billingDay: line.billingDay,
            billingInterval: line.billingInterval,
            serviceId: line.serviceId,
            subscriptionId: line.subscriptionId,
            revisesSubscriptionId: line.revisesSubscriptionId,
            groupTitle: line.groupTitle,
            isPackDiscount: line.isPackDiscount,
            subscriptionStart: line.subscriptionStart,
            subscriptionStartDate: line.subscriptionStartDate,
            subscriptionFreeMonths: line.subscriptionFreeMonths,
            commitmentMonths: line.commitmentMonths,
          })),
        },
      },
      include: { lines: true, client: true },
    });

    // Avenant : la période révisée est facturée par cette facture ; l'échéance avance maintenant, seulement pour les lignes
    // dont la signature a reporté le décalage (marqueur), une seule fois. Un devis signé avant ce fonctionnement a été
    // décalé à sa signature : aucun marqueur, aucun second décalage (audit du 25/10/2026).
    const shiftLater = invoicedLines.filter((l) => l.isSubscription && l.revisesSubscriptionId && l.revisionShiftDeferred);
    for (const subscriptionId of new Set(shiftLater.map((l) => l.revisesSubscriptionId!))) await shiftRevisedPeriod(subscriptionId, tx);
    if (shiftLater.length) await tx.invoiceLine.updateMany({ where: { id: { in: shiftLater.map((l) => l.id) } }, data: { revisionShiftDeferred: false } });

    await ensureQuoteHasOfficialNumber(tx, quote.id);
    await tx.invoice.update({
      where: { id: quote.id },
      data: {
        status: InvoiceStatus.PAID,
        quoteStatus: QuoteStatus.ACCEPTED,
        quoteDecidedAt: quote.quoteDecidedAt ?? new Date(),
      },
    });

    await ensureQuoteMilestones(quoteId, depositBaseOf(quote), tx);
    // Facture totale : les jalons d'acompte ne sont plus à payer. Sans cela, un lien de paiement
    // resté actif encaisserait un acompte qu'aucune facture ne pourrait plus porter.
    await tx.paymentMilestone.updateMany({
      where: {
        quoteId,
        invoiceId: null,
        status: { in: [MilestoneStatus.PENDING, MilestoneStatus.DUE, MilestoneStatus.OVERDUE, MilestoneStatus.FAILED] },
      },
      data: { status: MilestoneStatus.CANCELLED, checkoutUrl: null },
    });

    const subs = deferred
      ? { created: 0, subscriptionIds: [] as string[] }
      : await activateSubscriptionsFromDocument(quoteId, tx);

    // Propager subscriptionId des lignes devis → facture (même position)
    if (subs.subscriptionIds.length > 0) {
      const quoteLines = await tx.invoiceLine.findMany({
        where: { invoiceId: quoteId, isSubscription: true },
        orderBy: { position: "asc" },
      });
      const invLines = await tx.invoiceLine.findMany({
        where: { invoiceId: created.id, isSubscription: true },
        orderBy: { position: "asc" },
      });
      for (const qLine of quoteLines) {
        if (!qLine.subscriptionId) continue;
        const match = invLines.find((l) => l.position === qLine.position);
        if (match && !match.subscriptionId) {
          await tx.invoiceLine.update({
            where: { id: match.id },
            data: { subscriptionId: qLine.subscriptionId },
          });
        }
      }
    }

    const buyout = await applyBuyoutSignature(tx, quoteId);
    return {
      ...created,
      subscriptionsCreated: subs.created,
      subscriptionIds: subs.subscriptionIds,
      buyout,
    };
  });

  await finishBuyoutSignature(invoice.buyout);
  await notifyStripeSubscriptionSetup(invoice.subscriptionIds ?? []);
  const { buyout: _buyout, ...converted } = invoice;
  return converted;
}
