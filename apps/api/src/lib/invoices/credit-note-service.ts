import {
  CreditNoteReason,
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  PaymentMethod,
  Prisma,
  RefundMethod,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCompanySettings } from "@/lib/company";
import { allocateCreditNoteNumber } from "@/lib/invoices/numberingService";
import { buildClientSnapshot, type ClientSnapshot } from "@/lib/invoices/documentFlowService";

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
  maxCreditCents: number;
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

export async function assessCreditNoteEligibility(
  invoiceId: string,
): Promise<CreditNoteEligibility> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      client: { select: { displayName: true, clientNumber: true } },
      payments: { select: { amountCents: true } },
      creditNotes: { select: { totalCents: true, number: true } },
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

  const paidCents = invoice.payments.reduce((s, p) => s + p.amountCents, 0);
  const alreadyCreditedCents = invoice.creditNotes.reduce(
    (s, cn) => s + Math.abs(cn.totalCents),
    0,
  );
  const maxCreditCents = Math.max(
    0,
    Math.min(paidCents, invoice.totalCents) - alreadyCreditedCents,
  );

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

  if (paidCents <= 0) {
    return {
      ...base,
      code: "UNPAID",
      message:
        "Aucun encaissement sur cette facture : un avoir n'est pas nécessaire.",
      alternative:
        "Solution : conservez la facture dans la numérotation, émettez une nouvelle facture corrigée si besoin. Ne supprimez jamais une facture émise. Vous ne déclarez à l'URSSAF que ce qui a été réellement encaissé.",
    };
  }

  if (maxCreditCents <= 0) {
    return {
      ...base,
      code: "ALREADY_CREDITED",
      message: "Le montant encaissé est déjà entièrement couvert par un ou des avoirs.",
    };
  }

  return { ...base, allowed: true };
}

export async function createCreditNote(
  invoiceId: string,
  input: CreateCreditNoteInput,
) {
  const eligibility = await assessCreditNoteEligibility(invoiceId);
  if (!eligibility.allowed) {
    throw new CreditNoteError(
      eligibility.message ?? "Avoir non autorisé",
      eligibility.code ?? "BAD_STATUS",
    );
  }

  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > eligibility.maxCreditCents
  ) {
    throw new CreditNoteError(
      `Montant invalide (max ${eligibility.maxCreditCents} centimes HT = montant encaissé restant).`,
      "AMOUNT",
    );
  }

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
    input.refundMethod === RefundMethod.BANK_TRANSFER;

  return prisma.$transaction(async (tx) => {
    const original = await tx.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      include: {
        lines: { orderBy: { position: "asc" } },
        creditNotes: true,
        payments: true,
      },
    });

    const settings = await getCompanySettings();
    const allocated = await allocateCreditNoteNumber(issueDate, tx, settings);
    const snapshot =
      (original.clientSnapshot as ClientSnapshot | null) ??
      (await buildClientSnapshot(original.clientId, tx));

    const amount = input.amountCents;
    const fullCancel =
      amount >= original.totalCents &&
      original.creditNotes.length === 0;

    const description = reasonLineDescription(
      input.reason,
      original.number,
      input.reasonDetail,
    );

    const notesParts = [
      `Avoir sur facture ${original.number ?? "?"} du ${
        original.issueDate
          ? original.issueDate.toLocaleDateString("fr-FR")
          : "?"
      }`,
      `Motif : ${REASON_LABEL[input.reason]}`,
      input.reasonDetail?.trim() || null,
      `Remboursement : ${REFUND_LABEL[input.refundMethod]}`,
      input.refundMethod === RefundMethod.BANK_TRANSFER
        ? "Vous n'avez rien à payer."
        : null,
      input.refundMethod === RefundMethod.DEDUCT_FROM_BALANCE
        ? `À déduire du solde restant dû.`
        : null,
    ].filter(Boolean);

    const creditNote = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.CREDIT_NOTE,
        status: InvoiceStatus.ISSUED,
        clientId: original.clientId,
        clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        number: allocated.number,
        sequenceYear: allocated.sequenceYear,
        sequenceNumber: allocated.sequenceNumber,
        issueDate,
        dueDate: issueDate,
        issuedAt: new Date(),
        currency: original.currency,
        subtotalCents: -amount,
        totalCents: -amount,
        notes: notesParts.join("\n"),
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
          amountCents: -amount,
          paidAt: input.refundPaidAt ?? issueDate,
          method: PaymentMethod.BANK_TRANSFER,
          reference: `Avoir ${allocated.number}`,
          notes: "Remboursement client (ligne livre des recettes)",
        },
      });
    }

    if (fullCancel) {
      await tx.invoice.update({
        where: { id: original.id },
        data: { status: InvoiceStatus.CANCELLED },
      });
    }

    return creditNote;
  });
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
    refundMethod: RefundMethod.BANK_TRANSFER,
    cgvDepositRefundable: eligibility.isAcompte ? true : null,
    issueDate,
    registerRefundPayment: true,
  });
}

export { REASON_LABEL, REFUND_LABEL };
