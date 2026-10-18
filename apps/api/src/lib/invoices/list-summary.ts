import { InvoiceDocumentType, InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { startOfLocalDay } from "@/lib/finance/dates.js";

/**
 * Synthèse de la liste des devis ou des factures : nombres par statut (et par type pour les factures), devis à
 * relire, factures à l'échéance dépassée. Comptée sur toute la base, jamais sur une page de la liste.
 * Clés de statut identiques à celles de la liste web (lib/document-list.ts) : un avoir émis vaut CREDIT_ISSUED.
 */
export const CREDIT_ISSUED = "CREDIT_ISSUED";

export type ListSummary = {
  total: number;
  /** Nombres par statut, tous types confondus. */
  byStatus: Record<string, number>;
  /** Factures seulement : nombres par statut des factures et des avoirs. */
  byKind?: { factures: Record<string, number>; avoirs: Record<string, number> };
  /** Factures : émises, non réglées, échéance avant aujourd'hui. */
  overdue: number;
  /** Devis préparés hors ligne et créés avec un écart, à relire. */
  toReview: number;
};

const add = (bucket: Record<string, number>, key: string, n: number) => {
  bucket[key] = (bucket[key] ?? 0) + n;
};

export async function invoiceListSummary(type: "QUOTE" | "INVOICE", now = new Date()): Promise<ListSummary> {
  if (type === "QUOTE") {
    const where = { documentType: InvoiceDocumentType.QUOTE };
    const [groups, toReview] = await Promise.all([
      prisma.invoice.groupBy({ by: ["status", "quoteStatus"], where, _count: { _all: true } }),
      prisma.invoice.count({ where: { ...where, offlineReviewReason: { not: null } } }),
    ]);
    const byStatus: Record<string, number> = {};
    for (const g of groups) add(byStatus, g.quoteStatus ?? g.status, g._count._all);
    return { total: groups.reduce((n, g) => n + g._count._all, 0), byStatus, overdue: 0, toReview };
  }

  const where = { documentType: { in: [InvoiceDocumentType.INVOICE, InvoiceDocumentType.CREDIT_NOTE] } };
  const [groups, overdue] = await Promise.all([
    prisma.invoice.groupBy({ by: ["documentType", "status"], where, _count: { _all: true } }),
    prisma.invoice.count({
      where: { documentType: InvoiceDocumentType.INVOICE, status: InvoiceStatus.ISSUED, dueDate: { lt: startOfLocalDay(now) } },
    }),
  ]);
  const byStatus: Record<string, number> = {};
  const byKind = { factures: {} as Record<string, number>, avoirs: {} as Record<string, number> };
  for (const g of groups) {
    const credit = g.documentType === InvoiceDocumentType.CREDIT_NOTE;
    const key = credit && g.status === InvoiceStatus.ISSUED ? CREDIT_ISSUED : g.status;
    add(byStatus, key, g._count._all);
    add(credit ? byKind.avoirs : byKind.factures, key, g._count._all);
  }
  return { total: groups.reduce((n, g) => n + g._count._all, 0), byStatus, byKind, overdue, toReview: 0 };
}
