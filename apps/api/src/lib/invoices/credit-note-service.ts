import {
  CreditNoteReason,
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  PaymentMethod,
  Prisma,
  RefundMethod,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { archiveIssuedDocument } from "@/lib/pdf/issued-archive.js";
import { getCompanySettings } from "@/lib/company.js";
import { allocateCreditNoteNumber } from "@/lib/invoices/numberingService.js";
import { buildClientSnapshot, type ClientSnapshot } from "@/lib/invoices/documentFlowService.js";
import { clientSnapshotData, readClientSnapshot } from "@/lib/invoices/client-snapshot.js";
import { creditNoteCaps, invoiceBalance } from "@/lib/invoices/balance.js";
import { applySettledStatus, lockInvoice } from "@/lib/invoices/balance-status.js";
import { formatEUR } from "@/lib/money.js";
import { formatDateFr } from "@/lib/format-fr.js";

export class CreditNoteError extends Error {
  constructor(
    message: string,
    public code:
      | "UNPAID"
      | "NOT_INVOICE"
      | "BAD_STATUS"
      | "ALREADY_CREDITED"
      | "AMOUNT"
      | "CGV"
      | "NOT_FOUND",
  ) {
    super(message);
    this.name = "CreditNoteError";
  }
}

const REASON_LABEL: Record<CreditNoteReason, string> = {
  REFUND_DEPOSIT: "Remboursement d'acompte suite à annulation",
  COMMERCIAL_GESTURE: "Geste commercial",
  AMOUNT_CORRECTION: "Correction d'erreur de montant",
  STRIPE_CUSTOMER_CREDIT: "Crédit client Stripe appliqué",
};

const REFUND_LABEL: Record<RefundMethod, string> = {
  BANK_TRANSFER: "Virement de remboursement",
  DEDUCT_FROM_BALANCE: "Déduction sur solde restant dû",
  OTHER: "Autre mode de remboursement",
};

export type CreditNoteEligibility = {
  allowed: boolean;
  code?: CreditNoteError["code"];
  message?: string;
  alternative?: string;
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceIssueDate: string | null;
  invoiceType: InvoiceType;
  status: InvoiceStatus;
  clientName: string;
  clientNumber: string | null;
  invoiceTotalCents: number;
  paidCents: number;
  alreadyCreditedCents: number;
  /** Plafond d'un nouvel avoir : le net de la facture (total moins avoirs déjà émis). */
  maxCreditCents: number;
  /** Reste dû : la part d'un avoir jusqu'à ce montant est déduite ; au-delà, elle est à rembourser. */
  dueCents: number;
  /** Encaissé net (paiements moins remboursements) : ce qui peut être remboursé. */
  cashInCents: number;
  isAcompte: boolean;
  requiresCgvCheck: boolean;
  nextNumberPreview: string | null;
};

export type CreateCreditNoteInput = {
  amountCents: number;
  reason: CreditNoteReason;
  reasonDetail?: string | null;
  refundMethod: RefundMethod;
  /** Obligatoire si acompte + motif remboursement acompte */
  cgvDepositRefundable?: boolean | null;
  issueDate?: Date;
  /** Enregistre une ligne négative (livre des recettes) si virement */
  registerRefundPayment?: boolean;
  refundPaidAt?: Date;
};

function reasonLineDescription(
  reason: CreditNoteReason,
  originalNumber: string | null,
  detail?: string | null,
): string {
  const base = `${REASON_LABEL[reason]} (facture ${originalNumber ?? "?"})`;
  return detail?.trim() ? `${base} - ${detail.trim()}` : base;
}

/**
 * Part d'un avoir déduite du reste dû et part à rembourser (trop-perçu). Déduction seule quand l'avoir ne dépasse
 * pas le reste dû ; au-delà, la différence revient au client par le mode de remboursement choisi.
 */
export function creditNoteSplit(amountCents: number, dueCents: number): { deductedCents: number; refundCents: number } {
  const deductedCents = Math.min(amountCents, Math.max(0, dueCents));
  return { deductedCents, refundCents: amountCents - deductedCents };
}

/** Ligne et notes de l'avoir : mêmes textes à l'émission et dans l'aperçu avant émission. */
export function creditNoteContent(
  original: { number: string | null; issueDate: Date | null },
  input: Pick<CreateCreditNoteInput, "reason" | "reasonDetail" | "refundMethod">,
  split?: { deductedCents: number; refundCents: number },
): { description: string; notes: string } {
  const mixed = split && split.deductedCents > 0 && split.refundCents > 0;
  const notesParts = [
    `Avoir sur facture ${original.number ?? "?"} du ${
      original.issueDate
        ? formatDateFr(original.issueDate)
        : "?"
    }`,
    `Motif : ${REASON_LABEL[input.reason]}`,
    input.reasonDetail?.trim() || null,
    mixed
      ? `Déduit du solde restant dû : ${formatEUR(split.deductedCents)}. À rembourser : ${formatEUR(split.refundCents)} (${REFUND_LABEL[input.refundMethod].toLowerCase()}).`
      : `Remboursement : ${REFUND_LABEL[input.refundMethod]}`,
    input.refundMethod === RefundMethod.BANK_TRANSFER
      ? "Vous n'avez rien à payer."
      : null,
    input.refundMethod === RefundMethod.DEDUCT_FROM_BALANCE
      ? `À déduire du solde restant dû.`
      : null,
  ].filter(Boolean);
  return {
    description: reasonLineDescription(input.reason, original.number, input.reasonDetail),
    notes: notesParts.join("\n"),
  };
}

export async function assessCreditNoteEligibility(
  invoiceId: string,
  opts: { stripeCustomerCredit?: boolean } = {},
): Promise<CreditNoteEligibility> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      client: { select: { displayName: true, clientNumber: true } },
      payments: { select: { amountCents: true } },
      creditNotes: { select: { totalCents: true, number: true, payments: { select: { amountCents: true } } } },
    },
  });

  if (!invoice) {
    throw new CreditNoteError("Facture introuvable", "NOT_FOUND");
  }

  const settings = await getCompanySettings();
  const year = new Date().getFullYear();
  const counter = await prisma.counter.findUnique({
    where: {
      documentType_year: { documentType: "AVOIR", year },
    },
  });
  const next = (counter?.lastValue ?? 0) + 1;
  const width = settings.numberCounterWidth || 4;
  const tpl = settings.creditNoteNumberTemplate || "A-{year}-{counter}";
  const nextNumberPreview = tpl
    .replace("{year}", String(year))
    .replace("{counter}", String(next).padStart(width, "0"));

  // Avoir permis sur une facture impayée ou partiellement payée (décision d'Alexandre du 18/10/2026) : jusqu'au net,
  // déduit du reste dû puis remboursé au-delà (encaissé net).
  const balance = invoiceBalance(invoice);
  const paidCents = balance.paidCents;
  const alreadyCreditedCents = balance.creditedCents;
  const maxCreditCents = creditNoteCaps(balance).maxCents;

  const base: CreditNoteEligibility = {
    allowed: false,
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    invoiceIssueDate: invoice.issueDate?.toISOString() ?? null,
    invoiceType: invoice.invoiceType,
    status: invoice.status,
    clientName: invoice.client.displayName,
    clientNumber: invoice.client.clientNumber,
    invoiceTotalCents: invoice.totalCents,
    paidCents,
    alreadyCreditedCents,
    maxCreditCents,
    dueCents: balance.dueCents,
    cashInCents: balance.cashInCents,
    isAcompte: invoice.invoiceType === InvoiceType.ACOMPTE,
    requiresCgvCheck: invoice.invoiceType === InvoiceType.ACOMPTE,
    nextNumberPreview,
  };

  if (invoice.documentType !== InvoiceDocumentType.INVOICE) {
    return {
      ...base,
      code: "NOT_INVOICE",
      message: "Un avoir ne peut être émis que sur une facture.",
    };
  }

  if (
    invoice.status !== InvoiceStatus.ISSUED &&
    invoice.status !== InvoiceStatus.PAID
  ) {
    return {
      ...base,
      code: "BAD_STATUS",
      message: "Seules les factures émises ou payées peuvent recevoir un avoir.",
    };
  }

  // Échéance prélevée par Stripe (abonnement) et pas encore payée : Stripe prélèverait quand même le montant initial.
  // L'avoir se fait après le prélèvement, en remboursement.
  // Sauf l'avoir du crédit client Stripe : Stripe a déjà réglé cette part avec le solde du client, rien ne sera prélevé.
  if (invoice.stripeInvoiceId && balance.dueCents > 0 && !opts.stripeCustomerCredit) {
    return {
      ...base,
      code: "BAD_STATUS",
      message: "Échéance prélevée par Stripe et pas encore payée : émettez l'avoir après le prélèvement (remboursement), ou annulez l'échéance dans Stripe.",
    };
  }

  if (maxCreditCents <= 0) {
    return {
      ...base,
      code: "ALREADY_CREDITED",
      message: "La facture est déjà entièrement couverte par un ou des avoirs.",
    };
  }

  return { ...base, allowed: true };
}

/**
 * Montant et mode d'un avoir : entre 0,01 € et le net de la facture ; « déduction » seulement dans la limite du reste
 * dû, un mode de remboursement seulement s'il y a un trop-perçu. Rend la part déduite et la part à rembourser.
 * Mêmes contrôles à l'émission et dans l'aperçu.
 */
export function validateCreditNoteAmount(
  eligibility: Pick<CreditNoteEligibility, "maxCreditCents" | "dueCents">,
  amountCents: number,
  refundMethod: RefundMethod,
): { deductedCents: number; refundCents: number } {
  const input = { amountCents, refundMethod };
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > eligibility.maxCreditCents
  ) {
    throw new CreditNoteError(
      `Montant invalide : entre 0,01 € et ${formatEUR(eligibility.maxCreditCents)} (net de la facture).`,
      "AMOUNT",
    );
  }
  const split = creditNoteSplit(input.amountCents, eligibility.dueCents);
  if (input.refundMethod === RefundMethod.DEDUCT_FROM_BALANCE && split.refundCents > 0) {
    throw new CreditNoteError(
      `Au-delà du reste dû (${formatEUR(eligibility.dueCents)}), l'avoir est à rembourser : choisissez un mode de remboursement.`,
      "AMOUNT",
    );
  }
  if (input.refundMethod !== RefundMethod.DEDUCT_FROM_BALANCE && split.refundCents === 0) {
    throw new CreditNoteError(
      `L'avoir ne dépasse pas le reste dû (${formatEUR(eligibility.dueCents)}) : rien à rembourser, choisissez « Déduction sur solde restant dû ».`,
      "AMOUNT",
    );
  }
  return split;
}

export async function createCreditNote(
  invoiceId: string,
  input: CreateCreditNoteInput,
) {
  const stripeCustomerCredit = input.reason === CreditNoteReason.STRIPE_CUSTOMER_CREDIT;
  const eligibility = await assessCreditNoteEligibility(invoiceId, { stripeCustomerCredit });
  if (!eligibility.allowed) {
    throw new CreditNoteError(
      eligibility.message ?? "Avoir non autorisé",
      eligibility.code ?? "BAD_STATUS",
    );
  }

  const split = validateCreditNoteAmount(eligibility, input.amountCents, input.refundMethod);

  if (
    eligibility.isAcompte &&
    input.reason === CreditNoteReason.REFUND_DEPOSIT
  ) {
    if (input.cgvDepositRefundable === false) {
      throw new CreditNoteError(
        "Selon vos CGV l'acompte reste acquis : pas d'avoir à émettre, déclarez l'acompte comme recette.",
        "CGV",
      );
    }
    if (input.cgvDepositRefundable !== true) {
      throw new CreditNoteError(
        "Confirmez si vos CGV rendent l'acompte remboursable avant d'émettre l'avoir.",
        "CGV",
      );
    }
  }

  const issueDate = input.issueDate ?? new Date();
  const registerRefund =
    input.registerRefundPayment !== false &&
    input.refundMethod === RefundMethod.BANK_TRANSFER &&
    split.refundCents > 0;

  const settledRef: { value: { before: InvoiceStatus; after: InvoiceStatus } | null } = { value: null };
  const creditNote = await prisma.$transaction(async (tx) => {
    // Verrou d'écriture puis solde relu : un autre avoir ou un paiement enregistré entre-temps est pris en compte.
    await lockInvoice(tx, invoiceId);
    const original = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: {
        lines: { orderBy: { position: "asc" } },
        creditNotes: { include: { payments: { select: { amountCents: true } } } },
        payments: true,
      },
    });
    // Avoir du crédit client Stripe : un seul par facture, même si le webhook est rejoué (vérifié sous le verrou).
    if (stripeCustomerCredit && original.creditNotes.some((cn) => cn.creditReason === CreditNoteReason.STRIPE_CUSTOMER_CREDIT)) {
      throw new CreditNoteError("Crédit client Stripe déjà appliqué à cette facture.", "ALREADY_CREDITED");
    }
    const fresh = invoiceBalance(original);
    const locked = validateCreditNoteAmount({ maxCreditCents: creditNoteCaps(fresh).maxCents, dueCents: fresh.dueCents }, input.amountCents, input.refundMethod);
    if (locked.deductedCents !== split.deductedCents) {
      throw new CreditNoteError("La facture vient de changer (paiement ou avoir) : rouvrez l'assistant pour revoir le montant.", "AMOUNT");
    }

    const settings = await getCompanySettings();
    const allocated = await allocateCreditNoteNumber(issueDate, tx, settings);
    const snapshot: ClientSnapshot = readClientSnapshot(original) ?? (await buildClientSnapshot(original.clientId, tx));

    const amount = input.amountCents;
    const { description, notes } = creditNoteContent(original, input, split);

    const creditNote = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.CREDIT_NOTE,
        status: InvoiceStatus.ISSUED,
        clientId: original.clientId,
        ...clientSnapshotData(snapshot),
        number: allocated.number,
        sequenceYear: allocated.sequenceYear,
        sequenceNumber: allocated.sequenceNumber,
        issueDate,
        dueDate: issueDate,
        issuedAt: new Date(),
        currency: original.currency,
        subtotalCents: -amount,
        totalCents: -amount,
        notes,
        paymentTerms: original.paymentTerms,
        creditedInvoiceId: original.id,
        quoteId: original.quoteId,
        creditReason: input.reason,
        creditReasonDetail: input.reasonDetail?.trim() || null,
        refundMethod: input.refundMethod,
        cgvDepositRefundable:
          eligibility.isAcompte && input.reason === CreditNoteReason.REFUND_DEPOSIT
            ? true
            : null,
        creditFollowUp: {
          sentToClient: false,
          bankTransferDone: false,
          receiptsLineAdded: registerRefund,
          archivedWithOriginal: false,
          urssafImpactNoted: false,
          negativeCarryoverReminder: false,
        } as unknown as Prisma.InputJsonValue,
        lines: {
          create: [
            {
              position: 0,
              description,
              quantity: 1,
              unitPriceCents: -amount,
              lineTotalCents: -amount,
            },
          ],
        },
      },
      include: { lines: true, client: true, creditedInvoice: true },
    });

    if (registerRefund) {
      await tx.payment.create({
        data: {
          invoiceId: creditNote.id,
          // Seule la part au-delà du reste dû est rendue au client (livre des recettes : recette négative).
          amountCents: -split.refundCents,
          paidAt: input.refundPaidAt ?? issueDate,
          method: PaymentMethod.BANK_TRANSFER,
          reference: `Avoir ${allocated.number}`,
          notes: "Remboursement client (ligne livre des recettes)",
        },
      });
    }

    // Statut d'après le nouveau solde (Payée, Annulée), jalon d'acompte lié compris.
    settledRef.value = await applySettledStatus(tx, original.id);
    // Lien de paiement collé à la main (montant fixe, hors ERP) : faux après une déduction, retiré. Le lien ERP
    // (/api/public/pay/) recalcule le reste dû à chaque clic.
    if (split.deductedCents > 0 && original.checkoutUrl && !original.checkoutUrl.includes("/api/public/pay/")) {
      await tx.invoice.update({ where: { id: original.id }, data: { checkoutUrl: null, revolutOrderId: null } });
    }

    return creditNote;
  });
  await archiveIssuedDocument(creditNote.id);
  const settled = settledRef.value;
  if (settled && settled.after === InvoiceStatus.PAID && settled.before !== InvoiceStatus.PAID) {
    const { onInvoicePaidForProject } = await import("@/lib/projects/lifecycle.js");
    await onInvoicePaidForProject(invoiceId);
  }
  return creditNote;
}

/** Compat : annulation totale (ancien flux) si encaissement présent. */
export async function cancelInvoiceWithCreditNote(
  invoiceId: string,
  issueDate = new Date(),
) {
  const eligibility = await assessCreditNoteEligibility(invoiceId);
  if (!eligibility.allowed) {
    throw new CreditNoteError(
      eligibility.message ?? "Avoir non autorisé",
      eligibility.code ?? "BAD_STATUS",
    );
  }
  return createCreditNote(invoiceId, {
    amountCents: eligibility.maxCreditCents,
    reason:
      eligibility.isAcompte
        ? CreditNoteReason.REFUND_DEPOSIT
        : CreditNoteReason.AMOUNT_CORRECTION,
    reasonDetail: "Annulation totale de la facture",
    // Facture impayée : tout est déduit ; payée en tout ou partie : le trop-perçu est remboursé par virement.
    refundMethod:
      creditNoteSplit(eligibility.maxCreditCents, eligibility.dueCents).refundCents > 0
        ? RefundMethod.BANK_TRANSFER
        : RefundMethod.DEDUCT_FROM_BALANCE,
    cgvDepositRefundable: eligibility.isAcompte ? true : null,
    issueDate,
    registerRefundPayment: true,
  });
}

export { REASON_LABEL, REFUND_LABEL };
