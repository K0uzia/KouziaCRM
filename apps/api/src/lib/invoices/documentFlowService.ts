import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
  QuoteStatus,
  type Prisma,
} from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { decryptOptional } from "@/lib/crypto.js";
import { allocateInvoiceNumber } from "@/lib/invoices/numberingService.js";
import { ensureQuoteMilestones } from "@/lib/quotes/milestones.js";

export class DocumentFlowError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
  ) {
    super(message);
    this.name = "DocumentFlowError";
  }
}

export type ClientSnapshot = {
  displayName: string;
  type: string;
  email: string | null;
  phone: string | null;
  siret: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string;
};

export type BalanceAcompteLine = {
  invoiceId: string;
  number: string;
  amountCents: number;
  status: InvoiceStatus;
  paid: boolean;
  label: string;
  /** Montant déduit du solde (uniquement si réglé) */
  deductedCents: number;
};

export type BalanceSummary = {
  quoteId: string;
  quoteNumber: string | null;
  quoteIssueDate: string | null;
  marketTotalCents: number;
  acomptes: BalanceAcompteLine[];
  acomptesPaidCents: number;
  acomptesIssuedUnpaidCents: number;
  balanceDueCents: number;
  pendingMilestones: Array<{
    id: string;
    label: string;
    amountCents: number;
    status: MilestoneStatus;
  }>;
};

async function buildClientSnapshot(
  clientId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<ClientSnapshot> {
  const client = await db.client.findUniqueOrThrow({ where: { id: clientId } });
  return {
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
}

function isPaidInvoice(status: InvoiceStatus): boolean {
  return status === InvoiceStatus.PAID;
}

/** Calcule le récapitulatif de solde à la volée (jamais stocké en dur). */
export async function computeBalanceSummary(
  quoteId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<BalanceSummary> {
  const quote = await db.invoice.findUniqueOrThrow({
    where: { id: quoteId },
    include: {
      milestones: { orderBy: { position: "asc" } },
    },
  });
  if (quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new DocumentFlowError("Le document pivot doit être un devis", 400);
  }

  const marketInvoices = await db.invoice.findMany({
    where: {
      quoteId,
      documentType: InvoiceDocumentType.INVOICE,
      status: { not: InvoiceStatus.CANCELLED },
      invoiceType: { in: [InvoiceType.ACOMPTE, InvoiceType.SOLDE] },
    },
    orderBy: [{ issueDate: "asc" }, { createdAt: "asc" }],
  });

  const acomptes = marketInvoices
    .filter((i) => i.invoiceType === InvoiceType.ACOMPTE)
    .map((i) => {
      const paid = isPaidInvoice(i.status);
      return {
        invoiceId: i.id,
        number: i.number ?? "?",
        amountCents: i.totalCents,
        status: i.status,
        paid,
        label: paid
          ? `Acompte facturé et réglé (${i.number})`
          : `Acompte facturé non réglé (${i.number})`,
        /** Montant déjà facturé (déduit du solde, payé ou non) */
        deductedCents: i.totalCents,
      };
    });

  const acomptesPaidCents = acomptes
    .filter((a) => a.paid)
    .reduce((s, a) => s + a.amountCents, 0);
  const acomptesIssuedUnpaidCents = acomptes
    .filter((a) => !a.paid)
    .reduce((s, a) => s + a.amountCents, 0);
  const acomptesIssuedCents = acomptes.reduce((s, a) => s + a.amountCents, 0);

  const existingSolde = marketInvoices.find((i) => i.invoiceType === InvoiceType.SOLDE);
  // Solde = marché - acomptes déjà émis (chaque facture d'acompte reste due séparément)
  const balanceDueCents = existingSolde
    ? existingSolde.totalCents
    : Math.max(0, quote.totalCents - acomptesIssuedCents);

  const pendingMilestones = quote.milestones.filter(
    (m) => m.status === MilestoneStatus.PENDING && !m.invoiceId,
  );

  return {
    quoteId: quote.id,
    quoteNumber: quote.number,
    quoteIssueDate: quote.issueDate?.toISOString() ?? null,
    marketTotalCents: quote.totalCents,
    acomptes,
    acomptesPaidCents,
    acomptesIssuedUnpaidCents,
    balanceDueCents,
    pendingMilestones: pendingMilestones.map((m) => ({
      id: m.id,
      label: m.label,
      amountCents: m.amountCents,
      status: m.status,
    })),
  };
}

/** Vue marché : devis + jalons + factures sœurs. */
export async function getMarketView(quoteId: string) {
  const quote = await prisma.invoice.findUnique({
    where: { id: quoteId },
    include: {
      client: { select: { id: true, displayName: true, clientNumber: true } },
      milestones: {
        orderBy: { position: "asc" },
        include: {
          generatedInvoice: {
            include: { payments: true },
          },
        },
      },
    },
  });
  if (!quote || quote.documentType !== InvoiceDocumentType.QUOTE) {
    throw new DocumentFlowError("Devis introuvable", 404);
  }

  await ensureQuoteMilestones(quote.id, quote.totalCents);

  const milestones = await prisma.paymentMilestone.findMany({
    where: { quoteId },
    orderBy: { position: "asc" },
    include: {
      generatedInvoice: {
        include: { payments: true },
      },
    },
  });

  const marketInvoices = await prisma.invoice.findMany({
    where: {
      quoteId,
      documentType: InvoiceDocumentType.INVOICE,
      status: { not: InvoiceStatus.CANCELLED },
    },
    orderBy: [{ issueDate: "asc" }, { createdAt: "asc" }],
    include: { payments: true },
  });

  const summary = await computeBalanceSummary(quoteId);
  const paidMilestones = milestones.filter((m) => m.status === MilestoneStatus.PAID).length;
  const totalMilestones = milestones.length || 1;
  const encaisseCents = marketInvoices
    .flatMap((i) => i.payments)
    .reduce((s, p) => s + p.amountCents, 0);

  return {
    quote: {
      id: quote.id,
      number: quote.number,
      totalCents: quote.totalCents,
      status: quote.status,
      quoteStatus: quote.quoteStatus,
      issueDate: quote.issueDate,
      client: quote.client,
    },
    milestones: milestones.map((m) => ({
      id: m.id,
      position: m.position,
      label: m.label,
      percentBps: m.percentBps,
      amountCents: m.amountCents,
      triggerText: m.triggerText,
      status: m.status,
      invoiceId: m.invoiceId,
      invoice: m.generatedInvoice
        ? {
            id: m.generatedInvoice.id,
            number: m.generatedInvoice.number,
            status: m.generatedInvoice.status,
            invoiceType: m.generatedInvoice.invoiceType,
            totalCents: m.generatedInvoice.totalCents,
            paidCents: m.generatedInvoice.payments.reduce((s, p) => s + p.amountCents, 0),
          }
        : null,
    })),
    marketInvoices: marketInvoices.map((i) => ({
      id: i.id,
      number: i.number,
      invoiceType: i.invoiceType,
      status: i.status,
      totalCents: i.totalCents,
      paidCents: i.payments.reduce((s, p) => s + p.amountCents, 0),
      issueDate: i.issueDate,
    })),
    progress: {
      milestonesPaid: paidMilestones,
      milestonesTotal: totalMilestones,
      encaisseCents,
      marketTotalCents: quote.totalCents,
      encaissePercent:
        quote.totalCents > 0
          ? Math.round((encaisseCents / quote.totalCents) * 100)
          : 0,
    },
    balance: summary,
  };
}

/**
 * Génère une facture d'acompte autonome (série F-…) liée au devis pivot.
 * Verrou 409 si le jalon a déjà une facture.
 */
export async function generateMilestoneInvoice(
  milestoneId: string,
  issueDate = new Date(),
) {
  const invoice = await prisma.$transaction(async (tx) => {
    const milestone = await tx.paymentMilestone.findUniqueOrThrow({
      where: { id: milestoneId },
      include: { quote: true, generatedInvoice: true },
    });

    if (milestone.quote.documentType !== InvoiceDocumentType.QUOTE) {
      throw new DocumentFlowError("Jalon invalide", 400);
    }
    if (milestone.invoiceId || milestone.generatedInvoice) {
      throw new DocumentFlowError(
        "Une facture existe déjà pour ce jalon",
        409,
      );
    }
    if (milestone.status !== MilestoneStatus.PENDING) {
      throw new DocumentFlowError(
        "Ce jalon a déjà été facturé",
        409,
      );
    }

    const isSoldeMilestone =
      milestone.label.toLowerCase().includes("solde") ||
      milestone.position ===
        (
          await tx.paymentMilestone.aggregate({
            where: { quoteId: milestone.quoteId },
            _max: { position: true },
          })
        )._max.position;

    // Dernier jalon "Solde" : préférer generateBalanceInvoice
    if (isSoldeMilestone && milestone.label.toLowerCase().includes("solde")) {
      throw new DocumentFlowError(
        "Utilisez la facture de solde pour le dernier jalon (POST .../balance-invoice)",
        400,
      );
    }

    const allocated = await allocateInvoiceNumber(issueDate, tx);
    const snapshot = await buildClientSnapshot(milestone.quote.clientId, tx);
    const pct = (milestone.percentBps / 100).toFixed(0);
    const quoteRef = milestone.quote.number ?? "brouillon";
    const description = `Acompte de ${pct}% sur devis ${quoteRef} : ${milestone.label}${
      milestone.triggerText ? ` - ${milestone.triggerText}` : ""
    }`;

    const created = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.ACOMPTE,
        status: InvoiceStatus.ISSUED,
        clientId: milestone.quote.clientId,
        clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        number: allocated.number,
        sequenceYear: allocated.sequenceYear,
        sequenceNumber: allocated.sequenceNumber,
        issueDate,
        dueDate: issueDate,
        issuedAt: new Date(),
        milestoneId: milestone.id,
        quoteId: milestone.quoteId,
        sourceQuoteId: milestone.quoteId,
        marketTotalCents: milestone.quote.totalCents,
        subtotalCents: milestone.amountCents,
        totalCents: milestone.amountCents,
        paymentTerms: milestone.triggerText,
        notes: description,
        lines: {
          create: [
            {
              position: 0,
              description,
              quantity: 1,
              unitPriceCents: milestone.amountCents,
              lineTotalCents: milestone.amountCents,
            },
          ],
        },
      },
      include: { lines: true, client: true, payments: true },
    });

    await tx.paymentMilestone.update({
      where: { id: milestone.id },
      data: {
        status: MilestoneStatus.INVOICED,
        invoiceId: created.id,
      },
    });

    // Première facture d'acompte = acceptation commerciale du devis
    if (milestone.quote.quoteStatus !== QuoteStatus.ACCEPTED) {
      await tx.invoice.update({
        where: { id: milestone.quoteId },
        data: { quoteStatus: QuoteStatus.ACCEPTED },
      });
    }

    return { invoice: created, quoteId: milestone.quoteId };
  });

  const { activateSubscriptionsFromDocument } = await import(
    "@/lib/subscriptions/activate-from-document"
  );
  await activateSubscriptionsFromDocument(invoice.quoteId);

  return invoice.invoice;
}

/**
 * Facture de solde : montant = marché - acomptes réglés (dynamique).
 * @param force si true, autorise même si des jalons PENDING restent
 */
export async function generateBalanceInvoice(
  quoteId: string,
  opts: { issueDate?: Date; force?: boolean; milestoneId?: string } = {},
) {
  const issueDate = opts.issueDate ?? new Date();

  return prisma.$transaction(async (tx) => {
    const quote = await tx.invoice.findUniqueOrThrow({
      where: { id: quoteId },
      include: { milestones: { orderBy: { position: "asc" } } },
    });
    if (quote.documentType !== InvoiceDocumentType.QUOTE) {
      throw new DocumentFlowError("Devis introuvable", 404);
    }

    const existingSolde = await tx.invoice.findFirst({
      where: {
        quoteId,
        invoiceType: InvoiceType.SOLDE,
        status: { not: InvoiceStatus.CANCELLED },
      },
    });
    if (existingSolde) {
      throw new DocumentFlowError(
        `Une facture de solde existe déjà (${existingSolde.number ?? existingSolde.id})`,
        409,
      );
    }

    const summary = await computeBalanceSummary(quoteId, tx);
    if (summary.pendingMilestones.length > 0 && !opts.force) {
      throw new DocumentFlowError(
        `Des jalons ne sont pas encore facturés (${summary.pendingMilestones
          .map((m) => m.label)
          .join(", ")}). Passez force=true pour ignorer.`,
        409,
      );
    }

    if (summary.balanceDueCents <= 0) {
      throw new DocumentFlowError(
        "Aucun solde restant à facturer (acomptes déjà réglés couvrent le marché)",
        400,
      );
    }

    // Lier au jalon solde s'il existe et est libre
    let milestoneId = opts.milestoneId ?? null;
    if (!milestoneId) {
      const soldeMs = [...quote.milestones]
        .reverse()
        .find(
          (m) =>
            !m.invoiceId &&
            (m.label.toLowerCase().includes("solde") ||
              m.position === Math.max(...quote.milestones.map((x) => x.position))),
        );
      milestoneId = soldeMs?.id ?? null;
      if (soldeMs?.invoiceId) {
        throw new DocumentFlowError("Le jalon de solde a déjà une facture", 409);
      }
    }

    const allocated = await allocateInvoiceNumber(issueDate, tx);
    const snapshot = await buildClientSnapshot(quote.clientId, tx);
    const quoteRef = quote.number ?? "brouillon";
    const description = `Solde restant dû sur devis ${quoteRef}`;

    const invoice = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SOLDE,
        status: InvoiceStatus.ISSUED,
        clientId: quote.clientId,
        clientSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        number: allocated.number,
        sequenceYear: allocated.sequenceYear,
        sequenceNumber: allocated.sequenceNumber,
        issueDate,
        dueDate: issueDate,
        issuedAt: new Date(),
        milestoneId,
        quoteId: quote.id,
        sourceQuoteId: quote.id,
        marketTotalCents: quote.totalCents,
        subtotalCents: summary.balanceDueCents,
        totalCents: summary.balanceDueCents,
        paymentTerms: "Solde à réception",
        notes: `Facture de solde - marché ${quoteRef}`,
        lines: {
          create: [
            {
              position: 0,
              description,
              quantity: 1,
              unitPriceCents: summary.balanceDueCents,
              lineTotalCents: summary.balanceDueCents,
            },
          ],
        },
      },
      include: { lines: true, client: true, payments: true },
    });

    if (milestoneId) {
      await tx.paymentMilestone.update({
        where: { id: milestoneId },
        data: {
          status: MilestoneStatus.INVOICED,
          invoiceId: invoice.id,
          amountCents: summary.balanceDueCents,
        },
      });
    }

    return { invoice, summary };
  });
}

/** Synchronise le jalon quand sa facture passe PAID. */
export async function syncMilestoneOnInvoicePaid(
  invoiceId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const invoice = await db.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice?.milestoneId) return null;
  return db.paymentMilestone.update({
    where: { id: invoice.milestoneId },
    data: { status: MilestoneStatus.PAID, invoiceId: invoice.id },
  });
}

/**
 * Bloque la modification des montants du devis si au moins une facture marché existe.
 * Solution la plus sûre pour le contrôle fiscal (pas d'écart devis / acomptes).
 */
export async function assertQuoteEditable(quoteId: string) {
  const count = await prisma.invoice.count({
    where: {
      quoteId,
      documentType: InvoiceDocumentType.INVOICE,
      status: { not: InvoiceStatus.CANCELLED },
    },
  });
  if (count > 0) {
    throw new DocumentFlowError(
      "Devis verrouillé : au moins une facture du marché a été émise. Créez un avenant ou un nouvel avoir/devis.",
      409,
    );
  }
}

export { buildClientSnapshot };
