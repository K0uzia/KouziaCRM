import {
  InvoiceDocumentType,
  InvoiceStatus,
  MilestoneStatus,
  type Invoice,
  type Payment,
  type PaymentMilestone,
} from "@prisma/client";
import { signDocumentToken, signReceiptToken } from "@/lib/documents/public-token.js";
import { readableAvailable } from "@/lib/pdf/readable-documents.js";

type DocRow = Invoice & {
  payments: Payment[];
  milestones: PaymentMilestone[];
  /** Avoir : devis de la facture créditée (rattachement au projet). */
  creditedInvoice?: { quoteId: string | null } | null;
};

/** Devis d'origine → projet, limité aux projets visibles du client connecté. */
export type ProjectByQuote = ReadonlyMap<string, string>;

/**
 * Projet d'une pièce de l'espace client : devis → son projet, facture → projet de son devis,
 * avoir → projet de la facture créditée ; null sinon (devis en attente, pièce hors projet).
 */
export function projectOfDocument(
  byQuote: ProjectByQuote,
  d: Pick<Invoice, "id" | "documentType" | "quoteId"> & { creditedInvoice?: { quoteId: string | null } | null },
): string | null {
  const quoteId =
    d.documentType === InvoiceDocumentType.QUOTE
      ? d.id
      : d.documentType === InvoiceDocumentType.CREDIT_NOTE
        ? (d.creditedInvoice?.quoteId ?? d.quoteId)
        : d.quoteId;
  return quoteId ? (byQuote.get(quoteId) ?? null) : null;
}

export function buildDocumentLinks(docs: DocRow[]) {
  const byId = new Map(docs.map((d) => [d.id, d]));

  return docs.map((d) => {
    const linked: Array<{
      id: string;
      number: string | null;
      documentType: InvoiceDocumentType;
      status: InvoiceStatus;
      relation: "quote" | "invoice" | "credit_note";
    }> = [];

    if (d.quoteId) {
      const parent = byId.get(d.quoteId);
      if (parent) {
        linked.push({
          id: parent.id,
          number: parent.number,
          documentType: parent.documentType,
          status: parent.status,
          relation: "quote",
        });
      }
    }

    if (d.creditedInvoiceId) {
      const parent = byId.get(d.creditedInvoiceId);
      if (parent) {
        linked.push({
          id: parent.id,
          number: parent.number,
          documentType: parent.documentType,
          status: parent.status,
          relation: "invoice",
        });
      }
    }

    if (d.documentType === InvoiceDocumentType.QUOTE) {
      for (const child of docs) {
        if (child.quoteId === d.id && child.id !== d.id) {
          linked.push({
            id: child.id,
            number: child.number,
            documentType: child.documentType,
            status: child.status,
            relation: "invoice",
          });
        }
      }
    }

    if (d.documentType === InvoiceDocumentType.INVOICE) {
      for (const cn of docs) {
        if (cn.creditedInvoiceId === d.id) {
          linked.push({
            id: cn.id,
            number: cn.number,
            documentType: cn.documentType,
            status: cn.status,
            relation: "credit_note",
          });
        }
      }
    }

    return linked;
  });
}

export function buildPaymentHistory(opts: {
  docs: DocRow[];
  milestones: Array<
    PaymentMilestone & {
      quote: { number: string | null };
      generatedInvoice: { id: string; number: string | null } | null;
    }
  >;
  showAmounts: boolean;
  /** Rattachement des entrées à un projet (projectId, null sans projet). */
  projectByQuote?: ProjectByQuote;
}) {
  const byQuote = opts.projectByQuote ?? new Map<string, string>();
  const items: Array<{
    id: string;
    date: Date;
    amountCents: number;
    method: string;
    status: string;
    label: string;
    documentNumber: string | null;
    receiptToken: string | null;
    /** Reçu PDF de ce règlement (archivé) ; receiptToken reste le lien de la facture. */
    receiptPdfToken?: string | null;
    /** Contrat B (version accessible) : présent seulement si la version lisible du reçu existe. */
    receiptReadableAvailable?: true;
    projectId: string | null;
    /** Ajout du 28/10/2026 : PAYMENT (règlement reçu) ou CREDIT_NOTE (avoir émis, montant négatif), à afficher à part. */
    entryType: "PAYMENT" | "CREDIT_NOTE";
  }> = [];

  for (const m of opts.milestones) {
    if (m.status !== MilestoneStatus.PAID || !m.paidAt) continue;
    items.push({
      id: `milestone-${m.id}`,
      date: m.paidAt,
      amountCents: m.amountCents,
      method: m.paymentMethod ?? "CARD",
      status: "PAID",
      label: `${m.label} (devis ${m.quote.number ?? ""})`.trim(),
      documentNumber: m.generatedInvoice?.number ?? m.quote.number,
      receiptToken: m.generatedInvoice?.number
        ? signDocumentToken(m.generatedInvoice.id)
        : null,
      projectId: byQuote.get(m.quoteId) ?? null,
      entryType: "PAYMENT",
    });
  }

  for (const d of opts.docs) {
    if (d.documentType === InvoiceDocumentType.CREDIT_NOTE) {
      // Avoir émis : jamais un règlement reçu, montant négatif (audit du 28/10/2026 : il s'affichait « Règlement reçu »).
      items.push({
        id: `credit-${d.id}`,
        date: d.issueDate ?? d.createdAt,
        amountCents: -Math.abs(d.totalCents),
        method: "CREDIT_NOTE",
        status: d.status,
        label: `Avoir émis ${d.number ?? ""}`.trim(),
        documentNumber: d.number,
        receiptToken: d.number ? signDocumentToken(d.id) : null,
        projectId: projectOfDocument(byQuote, d),
        entryType: "CREDIT_NOTE",
      });
      continue;
    }

    // Facture d'un jalon payé : déjà comptée par l'entrée du jalon. Ne pas comparer les dates
    // (le jalon et le règlement sont horodatés séparément, à quelques millisecondes d'écart).
    const coveredByMilestone = opts.milestones.find(
      (m) => m.status === MilestoneStatus.PAID && m.paidAt && m.generatedInvoice?.id === d.id,
    );
    if (coveredByMilestone) {
      // Reçu du règlement de l'acompte : porté par l'entrée du jalon.
      const entry = items.find((i) => i.id === `milestone-${coveredByMilestone.id}`);
      const last = d.payments.filter((p) => p.amountCents > 0).sort((a, b) => b.paidAt.getTime() - a.paidAt.getTime())[0];
      if (entry && last && d.number) {
        entry.receiptPdfToken = signReceiptToken(last.id);
        if (readableAvailable(last.receiptReadableSnapshot)) entry.receiptReadableAvailable = true;
      }
      continue;
    }

    // Remboursement (montant négatif) : ni règlement ni reçu ; il réduit seulement le montant encaissé.
    for (const p of d.payments.filter((x) => x.amountCents > 0)) {
      items.push({
        id: `payment-${p.id}`,
        date: p.paidAt,
        amountCents: p.amountCents,
        method: p.method,
        status: "PAID",
        label: `Règlement ${d.number ?? ""}`.trim(),
        documentNumber: d.number,
        receiptToken: d.number ? signDocumentToken(d.id) : null,
        receiptPdfToken: d.number ? signReceiptToken(p.id) : null,
        ...(d.number && readableAvailable(p.receiptReadableSnapshot) ? { receiptReadableAvailable: true as const } : {}),
        projectId: projectOfDocument(byQuote, d),
        entryType: "PAYMENT",
      });
    }
  }

  items.sort((a, b) => b.date.getTime() - a.date.getTime());

  const mapped = opts.showAmounts
    ? items
    : items.map(({ amountCents: _a, ...rest }) => rest);

  // Règlements reçus seulement (28/10/2026) : un avoir n'en est pas un.
  const totalPaidCents = items
    .filter((i) => i.entryType === "PAYMENT" && i.amountCents > 0)
    .reduce((s, i) => s + i.amountCents, 0);
  // totalDueCents retiré (audit du 28/10/2026) : calculé sur le plus gros devis seul et réduit par les factures
  // d'abonnement, il était faux dès deux projets. /suivi lit totalNetDueCents (somme des restes dus, avoirs compris).
  // Ajout du 19/10/2026 (contrat /suivi) : avoirs et encaissé net. totalPaidCents ne compte que les règlements reçus,
  // jamais un avoir (28/10/2026). Remboursements : paiements négatifs portés par les avoirs.
  const creditNoteDocs = opts.docs.filter((d) => d.documentType === InvoiceDocumentType.CREDIT_NOTE);
  const totalCreditedCents = creditNoteDocs.reduce((s, d) => s + Math.abs(d.totalCents), 0);
  // Encaissé net d'après les règlements réels (jamais le montant théorique d'un jalon) : paiements reçus sur les
  // factures moins remboursements (lignes négatives des avoirs ou d'un trop-perçu).
  const allPayments = opts.docs.flatMap((d) => d.payments);
  const totalRefundedCents = allPayments.reduce((s, p) => s + (p.amountCents < 0 ? -p.amountCents : 0), 0);
  const totalReceivedCents = opts.docs
    .filter((d) => d.documentType !== InvoiceDocumentType.CREDIT_NOTE)
    .flatMap((d) => d.payments)
    .reduce((s, p) => s + (p.amountCents > 0 ? p.amountCents : 0), 0);
  const totalCashInCents = totalReceivedCents - totalRefundedCents;

  return {
    items: mapped,
    ...(opts.showAmounts ? { totalPaidCents, totalCreditedCents, totalRefundedCents, totalCashInCents } : {}),
  };
}
