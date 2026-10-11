import { getCompanySettings } from "@/lib/company.js";
import { extractEmailAddress } from "@/lib/email/mailer/headers.js";

/** En-tête posé sur tous les envois de l'ERP : la synchro IMAP reconnaît ses propres e-mails. */
export const OUTBOUND_HEADER = "X-Kouzia-Outbound";

/**
 * Adresses d'expédition de l'ERP (réglages SMTP, .env, expéditeur transactionnel) : un message
 * qui en vient, retrouvé dans la boîte de réception (copie, envoi à soi-même, alerte), est un envoi.
 */
export async function erpSenderAddresses(): Promise<Set<string>> {
  const s = await getCompanySettings();
  const raw = [
    s.smtpFrom,
    s.smtpUser,
    s.transactionalFrom,
    process.env.SMTP_FROM,
    process.env.SMTP_USER,
  ];
  const set = new Set<string>();
  for (const value of raw) {
    const addr = value?.trim() ? extractEmailAddress(value) : "";
    if (addr.includes("@")) set.add(addr);
  }
  return set;
}

/**
 * Envoi de l'ERP, quel que soit le dossier où il réapparaît : en-tête maison, Message-ID généré
 * par l'ERP (<id@kouzia.local>) ou expéditeur parmi les adresses d'envoi de l'ERP.
 */
export function isOwnOutboundMessage(
  msg: { fromAddress: string; messageId: string; outboundHeader?: string | null },
  senders: Set<string>,
): boolean {
  if (msg.outboundHeader?.trim() === "1") return true;
  if (/@kouzia\.local>?$/i.test(msg.messageId.trim())) return true;
  return senders.has(msg.fromAddress.trim().toLowerCase());
}

/** Valeur de l'en-tête maison dans le bloc d'en-têtes brut renvoyé par IMAP (Buffer ou texte). */
export function readOutboundHeader(rawHeaders: Buffer | string | undefined | null): string | null {
  if (!rawHeaders) return null;
  const text = typeof rawHeaders === "string" ? rawHeaders : rawHeaders.toString("utf8");
  const match = text.match(/^x-kouzia-outbound:\s*(.+)$/im);
  return match?.[1]?.trim() ?? null;
}
