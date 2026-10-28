import { BALANCE_INCLUDE, invoiceBalance } from "@/lib/invoices/balance.js";
import {
  InvoiceDocumentType,
  InvoiceStatus,
  InvoiceType,
  MilestoneStatus,
  type Prisma,
} from "@prisma/client";
import { archiveIssuedDocument } from "@/lib/pdf/issued-archive.js";
import { clientSnapshotData } from "@/lib/invoices/client-snapshot.js";
import { prisma } from "@/lib/prisma.js";
import { depositBaseOf } from "@/lib/invoices/totals.js";
import { activeTotalInvoiceOf, assertClientIdentified, assertDepositsPaid, assertQuoteSigned, milestoneInvoiceKind } from "@/lib/invoices/workflow.js";
import { snapshotOfClauses } from "@/lib/company/legal-clauses.js";
import { getCompanySettings } from "@/lib/company.js";
import { formatPercentBps } from "@/lib/format-fr.js";
import { decryptOptional } from "@/lib/crypto.js";
import { allocateInvoiceNumber } from "@/lib/invoices/numberingService.js";
import { ensureQuoteMilestonesFromSettings } from "@/lib/payments/milestonePaymentService.js";

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

/**
 * Clauses figées à l'émission d'une facture (audit du 28/10/2026), comme un devis : celles du devis d'origine s'il en
 * a figé, sinon les clauses actives pour le type du client. null : rien à figer (déjà figées, aucune clause en base).
 */
export async function invoiceClausesSnapshot(
  db: Prisma.TransactionClient | typeof prisma,
  doc: { legalClausesSnapshot?: unknown; quoteId?: string | null; sourceQuoteId?: string | null },
  clientType: string,
  vatMention: string,
): Promise<Prisma.InputJsonValue | null> {
  if (doc.legalClausesSnapshot != null) return null;
  const quoteId = doc.quoteId ?? doc.sourceQuoteId;
  if (quoteId) {
    const quote = await db.invoice.findUnique({ where: { id: quoteId }, select: { legalClausesSnapshot: true } });
    if (quote?.legalClausesSnapshot != null) return quote.legalClausesSnapshot as Prisma.InputJsonValue;
  }
  const active = await db.legalClause.findMany({ where: { active: true }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  if (active.length === 0) return null;
  return snapshotOfClauses(active, clientType, vatMention) as unknown as Prisma.InputJsonValue;
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
    include: BALANCE_INCLUDE,
  });

  // Avoir sur un acompte (décision d'Alexandre du 27/10/2026) : il corrige l'acompte seulement, le marché reste au prix
  // signé ; l'acompte compte pour son net (total moins avoirs) et le solde absorbe la différence.
  const acomptes = marketInvoices
    .filter((i) => i.invoiceType === InvoiceType.ACOMPTE)
    .map((i) => {
      const paid = isPaidInvoice(i.status);
      const netCents = invoiceBalance(i).netCents;
      return {
        invoiceId: i.id,
        number: i.number ?? "?",
        amountCents: netCents,
        status: i.status,
        paid,
        label: paid
          ? `Acompte facturé et réglé (${i.number})`
          : `Acompte facturé non réglé (${i.number})`,
        /** Montant déjà facturé net des avoirs (déduit du solde, payé ou non) */
        deductedCents: netCents,
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
  // Marché = partie ponctuelle du devis (l'abonnement est facturé à part, à chaque période).
  const marketTotalCents = depositBaseOf(quote);
  const balanceDueCents = existingSolde
    ? existingSolde.totalCents
    : Math.max(0, marketTotalCents - acomptesIssuedCents);

  const pendingMilestones = quote.milestones.filter(
    (m) => m.status === MilestoneStatus.PENDING && !m.invoiceId,
  );

  return {
    quoteId: quote.id,
    quoteNumber: quote.number,
    quoteIssueDate: quote.issueDate?.toISOString() ?? null,
    marketTotalCents,
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

  await ensureQuoteMilestonesFromSettings(quote.id, depositBaseOf(quote));

  const milestones = await prisma.paymentMilestone.findMany({
    where: { quoteId },
    orderBy: { position: "asc" },
    include: {
      generatedInvoice: {
        include: BALANCE_INCLUDE,
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
    include: BALANCE_INCLUDE,
  });

  const summary = await computeBalanceSummary(quoteId);
  const paidMilestones = milestones.filter((m) => m.status === MilestoneStatus.PAID).length;
  const totalMilestones = milestones.length || 1;
  // Encaissé net des remboursements portés par les avoirs (ou d'un trop-perçu remboursé).
  const encaisseCents = marketInvoices.reduce((s, i) => s + invoiceBalance(i).cashInCents, 0);

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
      triggerStepLabel: m.triggerStepLabel,
      triggeredAt: m.triggeredAt,
      status: m.status,
      dueDate: m.dueDate,
      checkoutUrl: m.checkoutUrl,
      paymentProcessingAt: m.paymentProcessingAt,
      revolutOrderId: m.revolutOrderId,
      paidAt: m.paidAt,
      paymentMethod: m.paymentMethod,
      manualReference: m.manualReference,
      invoiceId: m.invoiceId,
      invoice: m.generatedInvoice
        ? {
            id: m.generatedInvoice.id,
            number: m.generatedInvoice.number,
            status: m.generatedInvoice.status,
            invoiceType: m.generatedInvoice.invoiceType,
            totalCents: m.generatedInvoice.totalCents,
            paidCents: invoiceBalance(m.generatedInvoice).cashInCents,
          }
        : null,
    })),
    marketInvoices: marketInvoices.map((i) => ({
      id: i.id,
      number: i.number,
      invoiceType: i.invoiceType,
      status: i.status,
      totalCents: i.totalCents,
      paidCents: invoiceBalance(i).cashInCents,
      issueDate: i.issueDate,
    })),
    progress: {
      milestonesPaid: paidMilestones,
      milestonesTotal: totalMilestones,
      encaisseCents,
      marketTotalCents: depositBaseOf(quote),
      encaissePercent:
        depositBaseOf(quote) > 0
          ? Math.round((encaisseCents / depositBaseOf(quote)) * 100)
          : 0,
    },
    balance: summary,
  };
}

/**
 * Génère une facture d'acompte autonome (série F-…) liée au devis pivot.
 * Verrou 409 si le jalon a déjà une facture.
 */
/**
 * Paiement comptant (échéance unique) : facture simple du devis, mêmes lignes et remises (conversion du devis), émise
 * aussitôt avec les clauses figées du devis, et reliée à l'échéance.
 */
async function invoiceWholeQuoteForMilestone(milestoneId: string, quoteId: string, issueDate: Date) {
  const { convertQuoteToInvoice, issueInvoice } = await import("@/lib/invoices/transitions.js");
  const draft = await convertQuoteToInvoice(quoteId);
  const quote = await prisma.invoice.findUniqueOrThrow({ where: { id: quoteId }, select: { legalClausesSnapshot: true } });
  await prisma.invoice.update({
    where: { id: draft.id },
    data: {
      milestoneId,
      ...(quote.legalClausesSnapshot != null ? { legalClausesSnapshot: quote.legalClausesSnapshot as Prisma.InputJsonValue } : {}),
    },
  });
  await issueInvoice(draft.id, issueDate);
  await prisma.paymentMilestone.update({ where: { id: milestoneId }, data: { status: MilestoneStatus.INVOICED, invoiceId: draft.id } });
  return prisma.invoice.findUniqueOrThrow({ where: { id: draft.id }, include: { lines: true, client: true, payments: true } });
}

export async function generateMilestoneInvoice(
  milestoneId: string,
  issueDate = new Date(),
) {
  // Échéance unique ou dernière échéance : facture définitive (simple ou de solde), jamais une facture d'acompte.
  const target = await prisma.paymentMilestone.findUnique({ where: { id: milestoneId }, select: { quoteId: true, position: true, label: true, percentBps: true, invoiceId: true } });
  if (target && !target.invoiceId) {
    const kind = await milestoneInvoiceKind(target);
    if (kind === "BALANCE") return (await generateBalanceInvoice(target.quoteId, { issueDate, milestoneId })).invoice;
    if (kind === "FULL") return invoiceWholeQuoteForMilestone(milestoneId, target.quoteId, issueDate);
  }
  const settings = await getCompanySettings();
  const invoice = await prisma.$transaction(async (tx) => {
    const milestone = await tx.paymentMilestone.findUniqueOrThrow({
      where: { id: milestoneId },
      include: { quote: true, generatedInvoice: true },
    });

    if (milestone.quote.documentType !== InvoiceDocumentType.QUOTE) {
      throw new DocumentFlowError("Jalon invalide", 400);
    }
    await assertQuoteSigned(milestone.quoteId, tx);
    const totalInvoice = await activeTotalInvoiceOf(milestone.quoteId, tx);
    if (totalInvoice) {
      throw new DocumentFlowError(
        `Ce devis est déjà facturé en totalité${totalInvoice.number ? ` (${totalInvoice.number})` : ""} : pas d'acompte possible.`,
        409,
      );
    }
    if (milestone.invoiceId || milestone.generatedInvoice) {
      throw new DocumentFlowError(
        "Une facture existe déjà pour ce jalon",
        409,
      );
    }
    if (milestone.status !== MilestoneStatus.PENDING &&
        milestone.status !== MilestoneStatus.DUE &&
        milestone.status !== MilestoneStatus.OVERDUE &&
        milestone.status !== MilestoneStatus.FAILED) {
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

    await assertClientIdentified(milestone.quote.clientId, tx);
    const allocated = await allocateInvoiceNumber(issueDate, tx);
    const snapshot = await buildClientSnapshot(milestone.quote.clientId, tx);
    const legalClausesSnapshot = await invoiceClausesSnapshot(tx, { quoteId: milestone.quoteId }, snapshot.type, settings.vatMention);
    const pct = formatPercentBps(milestone.percentBps);
    const quoteRef = milestone.quote.number ?? "brouillon";
    const description = `Acompte de ${pct} sur devis ${quoteRef} : ${milestone.label}${
      milestone.triggerText ? ` - ${milestone.triggerText}` : ""
    }`;

    const created = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.ACOMPTE,
        status: InvoiceStatus.ISSUED,
        clientId: milestone.quote.clientId,
        ...clientSnapshotData(snapshot),
        number: allocated.number,
        sequenceYear: allocated.sequenceYear,
        sequenceNumber: allocated.sequenceNumber,
        issueDate,
        dueDate: issueDate,
        issuedAt: new Date(),
        milestoneId: milestone.id,
        quoteId: milestone.quoteId,
        sourceQuoteId: milestone.quoteId,
        // Rachat (R2) : la facture garde le lien vers l'abonnement racheté.
        buysOutSubscriptionId: milestone.quote.buysOutSubscriptionId,
        marketTotalCents: depositBaseOf(milestone.quote),
        subtotalCents: milestone.amountCents,
        totalCents: milestone.amountCents,
        paymentTerms: milestone.triggerText,
        notes: description,
        ...(legalClausesSnapshot ? { legalClausesSnapshot } : {}),
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

    return { invoice: created, quoteId: milestone.quoteId };
  });

  await archiveIssuedDocument(invoice.invoice.id);
  return invoice.invoice;
}

/** Facture de solde : montant = marché - acomptes émis nets des avoirs (dynamique). */
export async function generateBalanceInvoice(
  quoteId: string,
  opts: { issueDate?: Date; milestoneId?: string } = {},
) {
  const issueDate = opts.issueDate ?? new Date();
  const settings = await getCompanySettings();

  const result = await prisma.$transaction(async (tx) => {
    const quote = await tx.invoice.findUniqueOrThrow({
      where: { id: quoteId },
      include: { milestones: { orderBy: { position: "asc" } } },
    });
    if (quote.documentType !== InvoiceDocumentType.QUOTE) {
      throw new DocumentFlowError("Devis introuvable", 404);
    }
    await assertQuoteSigned(quoteId, tx);
    await assertDepositsPaid(quoteId, tx);

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
    // Devis déjà facturé en totalité (facture simple) : un solde le facturerait deux fois.
    const totalInvoice = await activeTotalInvoiceOf(quoteId, tx);
    if (totalInvoice) {
      throw new DocumentFlowError(
        `Ce devis est déjà facturé en totalité${totalInvoice.number ? ` (${totalInvoice.number})` : ""} : pas de facture de solde.`,
        409,
      );
    }

    const summary = await computeBalanceSummary(quoteId, tx);
    // Les acomptes doivent être payés (assertDepositsPaid ci-dessus) : le jalon « Solde » encore
    // en attente est justement celui que cette facture couvre, il ne bloque pas.

    if (summary.balanceDueCents <= 0) {
      throw new DocumentFlowError(
        "Aucun solde restant à facturer (acomptes déjà réglés couvrent le marché)",
        400,
      );
    }

    // Jalon du solde : le dernier (annulés compris dans le rang), libre et non annulé.
    let milestoneId = opts.milestoneId ?? null;
    if (!milestoneId) {
      const lastPosition = Math.max(...quote.milestones.map((x) => x.position));
      const soldeMs = [...quote.milestones]
        .reverse()
        .find(
          (m) =>
            !m.invoiceId &&
            m.status !== MilestoneStatus.CANCELLED &&
            (m.label.toLowerCase().includes("solde") || m.position === lastPosition),
        );
      milestoneId = soldeMs?.id ?? null;
    }

    await assertClientIdentified(quote.clientId, tx);
    const allocated = await allocateInvoiceNumber(issueDate, tx);
    const snapshot = await buildClientSnapshot(quote.clientId, tx);
    const legalClausesSnapshot = await invoiceClausesSnapshot(tx, quote, snapshot.type, settings.vatMention);
    const quoteRef = quote.number ?? "brouillon";
    const description = `Solde restant dû sur devis ${quoteRef}`;

    const invoice = await tx.invoice.create({
      data: {
        documentType: InvoiceDocumentType.INVOICE,
        invoiceType: InvoiceType.SOLDE,
        status: InvoiceStatus.ISSUED,
        clientId: quote.clientId,
        ...clientSnapshotData(snapshot),
        number: allocated.number,
        sequenceYear: allocated.sequenceYear,
        sequenceNumber: allocated.sequenceNumber,
        issueDate,
        dueDate: issueDate,
        issuedAt: new Date(),
        milestoneId,
        quoteId: quote.id,
        sourceQuoteId: quote.id,
        // Rachat (R2) : la facture garde le lien vers l'abonnement racheté.
        buysOutSubscriptionId: quote.buysOutSubscriptionId,
        marketTotalCents: depositBaseOf(quote),
        subtotalCents: summary.balanceDueCents,
        totalCents: summary.balanceDueCents,
        paymentTerms: "Solde à réception",
        notes: `Facture de solde - marché ${quoteRef}`,
        ...(legalClausesSnapshot ? { legalClausesSnapshot } : {}),
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
  await archiveIssuedDocument(result.invoice.id);
  return result;
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
