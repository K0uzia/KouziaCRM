/**
 * Maintenance du site (28/10/2026) : la maintenance comprise dans un pack (197 €) n'est jamais proposée seule ; en
 * paiement unique, l'option est la maintenance vendue seule (350 €). Identifiants fixes posés par l'API
 * (apps/api/src/lib/services/maintenance-offers.ts, même correspondance).
 */
const ONE_OFF_EQUIVALENT: Readonly<Record<string, string>> = { "kouzia-maintenance-site-pack": "kouzia-maintenance-site" };

/** Offre à proposer en option en paiement unique : l'équivalent vendu seul s'il est au catalogue, sinon elle-même. */
export function oneOffOffer<T extends { id: string }>(svc: T, services: readonly T[]): T {
  const id = ONE_OFF_EQUIVALENT[svc.id];
  return (id && services.find((s) => s.id === id)) || svc;
}
