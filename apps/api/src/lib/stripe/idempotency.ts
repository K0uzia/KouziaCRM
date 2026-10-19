import { createHash } from "node:crypto";

/**
 * Clé d'idempotence Stripe du jour : mêmes paramètres, même jour (heure de Paris) = même session. Un lien de paiement
 * ouvert plusieurs fois (client, antivirus de messagerie, aperçu de lien) ne crée qu'une session par jour, qui expire
 * seule ; un montant ou des moyens différents donnent une autre clé. Stripe garde une clé 24 h.
 */
export function dailyIdempotencyKey(scope: string, params: unknown, now = new Date()): string {
  const day = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris" }).format(now);
  const digest = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 32);
  return `kouzia:${scope}:${day}:${digest}`;
}
