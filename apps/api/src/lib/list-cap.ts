/**
 * Plafond de sécurité des listes complètes (retraits, déclarations URSSAF, versements Stripe) : bien au-delà des volumes
 * d'une micro-entreprise ; s'il est atteint, la réponse le dit (jamais une liste tronquée sans le signaler).
 */
export const LIST_CAP = 5_000;
