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
 * Date | Facture | Code client | Client | Nature | Règlement | Montant
 */
export function receiptsToCsv(
  rows: Array<{
    paidAt: string;
    invoiceNumber: string | null;
    amountCents: number;
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
    "Montant",
  ]
    .map(csvEscape)
    .join(";");

  const lines = rows.map((r) => {
    const date = new Date(r.paidAt).toLocaleDateString("fr-FR");
    const amount = (r.amountCents / 100).toFixed(2).replace(".", ",");
    return [
      date,
      r.invoiceNumber ?? "",
      r.clientNumber ?? "",
      r.clientName,
      r.nature,
      r.paymentMethodLabel,
      amount,
    ]
      .map(csvEscape)
      .join(";");
  });

  return `\uFEFF${[header, ...lines].join("\r\n")}`;
}
