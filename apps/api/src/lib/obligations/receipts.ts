import type { PaymentMethod } from "@prisma/client";

const LABELS: Record<PaymentMethod, string> = {
  BANK_TRANSFER: "Virement",
  CARD: "Carte",
  CHECK: "Chèque",
  CASH: "Espèces",
  OTHER: "Autre",
};

export function paymentMethodLabel(method: PaymentMethod): string {
  return LABELS[method] ?? method;
}

/** Encaissement rapproché sans facture (virement reçu hors facturation). */
export const UNLINKED_RECEIPT_NATURE = "Encaissement sans facture rattachée";
export const UNLINKED_RECEIPT_CLIENT = "Client non identifié";

export type ReceiptSourcePayment = {
  id: string;
  paidAt: Date;
  amountCents: number;
  method: PaymentMethod;
  reference: string | null;
  notes: string | null;
  invoice: {
    id: string;
    number: string | null;
    notes: string | null;
    invoiceType: string;
    documentType: string;
    totalCents: number;
    client: { displayName: string; clientNumber: string | null };
    lines: Array<{ description: string }>;
  } | null;
};

export type ReceiptRow = {
  id: string;
  paidAt: string;
  invoiceNumber: string | null;
  invoiceId: string | null;
  invoiceType: string | null;
  documentType: string | null;
  amountCents: number;
  /** Total HT de la facture liée (si disponible). */
  invoiceTotalCents: number | null;
  clientName: string;
  clientNumber: string | null;
  nature: string;
  paymentMethod: PaymentMethod;
  paymentMethodLabel: string;
  reference: string | null;
};

/**
 * Ligne du livre de recettes. La facture est optionnelle : un encaissement
 * rapproché sans facture doit figurer au registre, pas le faire échouer.
 */
export function buildReceiptRow(payment: ReceiptSourcePayment): ReceiptRow {
  const invoice = payment.invoice;

  let nature =
    invoice?.lines.map((l) => l.description).join(" · ") ||
    invoice?.notes ||
    payment.notes ||
    (invoice ? "Prestation de services" : UNLINKED_RECEIPT_NATURE);

  if (!invoice && payment.reference) {
    nature = `${nature} (réf. ${payment.reference})`;
  }
  if (invoice?.documentType === "CREDIT_NOTE" || payment.amountCents < 0) {
    nature = `Avoir · ${nature}`;
  }

  return {
    id: payment.id,
    paidAt: payment.paidAt.toISOString(),
    invoiceNumber: invoice?.number ?? null,
    invoiceId: invoice?.id ?? null,
    invoiceType: invoice?.invoiceType ?? null,
    documentType: invoice?.documentType ?? null,
    amountCents: payment.amountCents,
    invoiceTotalCents: invoice?.totalCents ?? null,
    clientName: invoice?.client.displayName ?? UNLINKED_RECEIPT_CLIENT,
    clientNumber: invoice?.client.clientNumber ?? null,
    nature,
    paymentMethod: payment.method,
    paymentMethodLabel: paymentMethodLabel(payment.method),
    reference: payment.reference,
  };
}

/** Sélection Prisma commune aux trois sorties du livre de recettes. */
export const receiptPaymentInclude = {
  invoice: {
    include: {
      client: { select: { displayName: true, clientNumber: true } },
      lines: { orderBy: { position: "asc" }, take: 3 },
    },
  },
} as const;

/** Période d'encaissements à partir des query params year / quarter / month. */
export function receiptsPeriod(q: {
  year?: string;
  quarter?: string;
  month?: string;
}): { year: number; start: Date; end: Date } {
  const year = q.year ? Number(q.year) : new Date().getFullYear();
  if (q.month) {
    const month = Number(q.month);
    return {
      year,
      start: new Date(year, month - 1, 1, 0, 0, 0, 0),
      end: new Date(year, month, 0, 23, 59, 59, 999),
    };
  }
  if (q.quarter) {
    const quarter = Number(q.quarter);
    const startMonth = (quarter - 1) * 3;
    return {
      year,
      start: new Date(year, startMonth, 1, 0, 0, 0, 0),
      end: new Date(year, startMonth + 3, 0, 23, 59, 59, 999),
    };
  }
  return {
    year,
    start: new Date(year, 0, 1, 0, 0, 0, 0),
    end: new Date(year, 11, 31, 23, 59, 59, 999),
  };
}

/** Encapsule toujours les cellules (évite le split Excel sur la virgule décimale). */
export function csvEscape(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Colonnes alignées sur le PDF / écran :
 * Date | Facture | Code client | Client | Nature | Règlement | Encaissé | Total facture
 */
export function receiptsToCsv(
  rows: Array<{
    paidAt: string;
    invoiceNumber: string | null;
    amountCents: number;
    invoiceTotalCents?: number | null;
    clientName: string;
    clientNumber?: string | null;
    nature: string;
    paymentMethodLabel: string;
  }>,
): string {
  const header = [
    "Date",
    "Facture",
    "Code client",
    "Client",
    "Nature",
    "Règlement",
    "Encaissé",
    "Total facture",
  ]
    .map(csvEscape)
    .join(";");

  const lines = rows.map((r) => {
    const date = new Date(r.paidAt).toLocaleDateString("fr-FR");
    const amount = (r.amountCents / 100).toFixed(2).replace(".", ",");
    const invoiceTotal =
      r.invoiceTotalCents != null
        ? (r.invoiceTotalCents / 100).toFixed(2).replace(".", ",")
        : "";
    return [
      date,
      r.invoiceNumber ?? "",
      r.clientNumber ?? "",
      r.clientName,
      r.nature,
      r.paymentMethodLabel,
      amount,
      invoiceTotal,
    ]
      .map(csvEscape)
      .join(";");
  });

  return `\uFEFF${[header, ...lines].join("\r\n")}`;
}
