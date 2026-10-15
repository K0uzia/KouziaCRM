// Médiation de la consommation (L612-1 du Code de la consommation) : obligatoire dès qu'un particulier
// peut signer. Le médiateur est déclaré dans Réglages > Mentions légales (clause « Médiation de la
// consommation »). Sans lui, aucun devis n'est envoyé en signature en ligne à un particulier.

export const MEDIATOR_REQUIRED_MESSAGE =
  "Un médiateur de la consommation est obligatoire pour signer avec un particulier (L612-1). Renseignez-le dans Réglages > Mentions légales";

export class MediatorRequiredError extends Error {
  readonly code = "MEDIATOR_REQUIRED";
  constructor() {
    super(MEDIATOR_REQUIRED_MESSAGE);
    this.name = "MediatorRequiredError";
  }
}

export const hasMediator = (settings: { mediationClause: string | null }) => Boolean(settings.mediationClause?.trim());

/** Particulier (B2C) sans médiateur déclaré : refus. Professionnel ou association : rien à vérifier. */
export function assertMediatorFor(clientType: string, settings: { mediationClause: string | null }): void {
  if (clientType === "B2C" && !hasMediator(settings)) throw new MediatorRequiredError();
}
