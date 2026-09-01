const CONFIRMATION_PATTERNS = [
  /\bje valide\b/i,
  /\bc'est confirm/i,
  /\bok pour moi\b/i,
  /\bbon pour accord\b/i,
  /\bje confirme\b/i,
  /\bc'est bon\b/i,
  /\bparfait pour moi\b/i,
];

/** Détecte une formulation de validation de devis dans un corps d'email entrant. */
export function detectQuoteConfirmationIntent(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  const normalized = text
    .replace(/[\u2018\u2019']/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return CONFIRMATION_PATTERNS.some((pattern) => pattern.test(normalized));
}
