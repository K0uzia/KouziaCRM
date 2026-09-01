import {
  InvoiceDocumentType,
  InvoiceStatus,
  MilestoneStatus,
  type Invoice,
  type Payment,
  type PaymentMilestone,
} from "@prisma/client";
import { signDocumentToken } from "@/lib/documents/public-token.js";

type DocRow = Invoice & {
  payments: Payment[];
  milestones: PaymentMilestone[];
};

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
}) {
  const items: Array<{
    id: string;
    date: Date;
    amountCents: number;
    method: string;
    status: string;
    label: string;
    documentNumber: string | null;
    receiptToken: string | null;
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
    });
  }

  for (const d of opts.docs) {
    if (d.documentType === InvoiceDocumentType.CREDIT_NOTE) {
      items.push({
        id: `credit-${d.id}`,
        date: d.issueDate ?? d.createdAt,
        amountCents: -d.totalCents,
        method: "CREDIT_NOTE",
        status: d.status,
        label: `Avoir ${d.number ?? ""}`.trim(),
        documentNumber: d.number,
        receiptToken: d.number ? signDocumentToken(d.id) : null,
      });
      continue;
    }

    for (const p of d.payments) {
      const linkedMilestone = opts.milestones.find(
        (m) => m.generatedInvoice?.id === d.id && m.paidAt?.getTime() === p.paidAt.getTime(),
      );
      if (linkedMilestone) continue;

      items.push({
        id: `payment-${p.id}`,
        date: p.paidAt,
        amountCents: p.amountCents,
        method: p.method,
        status: "PAID",
        label: `Règlement ${d.number ?? ""}`.trim(),
        documentNumber: d.number,
        receiptToken: d.number ? signDocumentToken(d.id) : null,
      });
    }
  }

  items.sort((a, b) => b.date.getTime() - a.date.getTime());

  const mapped = opts.showAmounts
    ? items
    : items.map(({ amountCents: _a, ...rest }) => rest);

  const totalPaidCents = items
    .filter((i) => i.amountCents > 0)
    .reduce((s, i) => s + i.amountCents, 0);
  const totalCreditCents = items
    .filter((i) => i.amountCents < 0)
    .reduce((s, i) => s + Math.abs(i.amountCents), 0);
  const marketTotal = opts.docs
    .filter((d) => d.documentType === InvoiceDocumentType.QUOTE)
    .reduce((max, d) => Math.max(max, d.totalCents), 0);
  const totalDueCents = Math.max(0, marketTotal - totalPaidCents + totalCreditCents);

  return {
    items: mapped,
    ...(opts.showAmounts ? { totalPaidCents, totalDueCents } : {}),
  };
}
