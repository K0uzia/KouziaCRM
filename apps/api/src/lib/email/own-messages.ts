/** En-tête posé sur tous les envois de l'ERP : la synchro IMAP reconnaît ses propres e-mails. */
export const OUTBOUND_HEADER = "X-Kouzia-Outbound";

/**
 * Envoi de l'ERP retrouvé hors du dossier Envoyés (copie, alerte à soi-même) : seulement s'il porte
 * notre en-tête ou notre Message-ID (<id@kouzia.local>). L'expéditeur seul ne suffit jamais :
 * un vrai message reçu peut venir de contact@ (envoi à soi-même, formulaire relayé, autre boîte).
 */
export function isOwnOutboundMessage(msg: { messageId: string; outboundHeader?: string | null }): boolean {
  if (msg.outboundHeader?.trim() === "1") return true;
  return /@kouzia\.local>?$/i.test(msg.messageId.trim());
}

/** Valeur de l'en-tête maison dans le bloc d'en-têtes brut renvoyé par IMAP (Buffer ou texte). */
export function readOutboundHeader(rawHeaders: Buffer | string | undefined | null): string | null {
  if (!rawHeaders) return null;
  const text = typeof rawHeaders === "string" ? rawHeaders : rawHeaders.toString("utf8");
  const match = text.match(/^x-kouzia-outbound:\s*(.+)$/im);
  return match?.[1]?.trim() ?? null;
}
