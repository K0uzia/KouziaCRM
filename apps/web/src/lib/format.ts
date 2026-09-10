export function formatEUR(cents: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

/** Affichage téléphone FR : 07 78 55 18 25 (sinon inchangé). */
export function formatPhoneFr(phone: string | null | undefined): string {
  if (!phone) return "";
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  let local = digits;
  if (digits.length === 11 && digits.startsWith("33")) {
    local = `0${digits.slice(2)}`;
  } else if (digits.length === 12 && digits.startsWith("330")) {
    local = `0${digits.slice(3)}`;
  }
  if (local.length === 10 && local.startsWith("0")) {
    return local.replace(/(\d{2})(?=\d)/g, "$1 ").trim();
  }
  return trimmed;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return " - ";
  return new Date(value).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export const statusLabel: Record<string, string> = {
  DRAFT: "Brouillon",
  ISSUED: "Émis",
  PAID: "Payé / Accepté",
  CANCELLED: "Annulé",
};

/** Labels métier devis (quoteStatus prioritaire) */
export const quoteStatusLabel: Record<string, string> = {
  DRAFT: "Brouillon",
  SENT: "Envoyé",
  ACCEPTED: "Accepté",
  REJECTED: "Refusé",
  EXPIRED: "Expiré",
  // legacy InvoiceStatus fallback
  ISSUED: "Envoyé",
  PAID: "Accepté",
  CANCELLED: "Refusé / annulé",
};

export const invoiceStatusLabel: Record<string, string> = {
  DRAFT: "Brouillon",
  ISSUED: "À encaisser",
  PAID: "Payée",
  CANCELLED: "Annulée",
};

export function statusTone(status: string): "neutral" | "teal" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "DRAFT":
      return "neutral";
    case "ISSUED":
    case "SENT":
      return "blue";
    case "PAID":
    case "ACCEPTED":
      return "green";
    case "CANCELLED":
    case "REJECTED":
    case "EXPIRED":
      return "red";
    case "PENDING":
      return "amber";
    case "INVOICED":
      return "teal";
    default:
      return "neutral";
  }
}

/** Statuts d'un virement bancaire importé depuis Revolut. */
export const bankStatusLabel: Record<string, string> = {
  PENDING: "En attente",
  MATCHED: "Associé",
  UNMATCHED: "À associer",
  IGNORED: "Ignoré",
};

export const paymentMethodLabel: Record<string, string> = {
  BANK_TRANSFER: "Virement",
  CARD: "Carte",
  CHECK: "Chèque",
  CASH: "Espèces",
  OTHER: "Autre",
};
