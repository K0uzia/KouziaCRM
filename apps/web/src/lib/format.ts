export function formatEUR(cents: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

/** Nombre décimal à la française (virgule) : 12,5. */
export function formatDecimal(value: number, maxFractionDigits = 2): string {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: maxFractionDigits }).format(value);
}

/** Taille de fichier : 820 o, 12 Ko, 1,5 Mo. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${formatDecimal(bytes / (1024 * 1024), 1)} Mo`;
}

/** Synchro de la messagerie considérée en panne au-delà de ce délai (IMAP configuré). */
export const MAIL_SYNC_STALE_MIN = 15;

/** Minutes écoulées depuis une date ISO (null si absente). */
export function minutesSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/** « à l'instant », « il y a 5 min », « il y a 2 h ». */
export function formatAgoMinutes(min: number): string {
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  return `il y a ${Math.floor(min / 60)} h`;
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

/** Heure locale HH:MM */
export function formatTime(value: string | Date | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Date courte d'une liste de messages : 14:02 aujourd'hui, « 12 oct. » cette année, 12/10/25 sinon. */
export function formatShortDate(value: string | Date | null | undefined, now = new Date()): string {
  if (!value) return "";
  const d = new Date(value);
  if (d.toDateString() === now.toDateString()) return formatTime(d);
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  }
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" });
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

export const paymentMethodLabel: Record<string, string> = {
  BANK_TRANSFER: "Virement",
  CARD: "Carte",
  SEPA_DEBIT: "Prélèvement SEPA",
  CHECK: "Chèque",
  CASH: "Espèces",
  OTHER: "Autre",
};
