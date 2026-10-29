/**
 * Prix annuel d'un abonnement du catalogue (audit du 28/10/2026), une seule règle partagée avec l'ERP web (alias
 * @kouzia-erp/annual-price) : le prix annuel du catalogue s'il est renseigné ; sinon un prix annuel tel quel, et un prix
 * mensuel ou trimestriel ramené à 12 mois moins les mois offerts des réglages (annualFreeMonths).
 */
export function annualPriceOfService(
  svc: { unitPriceCents: number; billingInterval?: string | null; annualPriceCents?: number | null },
  annualFreeMonths: number,
): number {
  if (svc.annualPriceCents != null) return svc.annualPriceCents;
  if (svc.billingInterval === "YEAR") return svc.unitPriceCents;
  const paidMonths = 12 - Math.min(12, Math.max(0, annualFreeMonths));
  const monthsPerPeriod = svc.billingInterval === "QUARTER" ? 3 : 1;
  return Math.round((svc.unitPriceCents * paidMonths) / monthsPerPeriod);
}

/**
 * Prix d'une échéance depuis le prix annuel (règle « l'annuel coûte moins cher », décision d'Alexandre du 28/10/2026) :
 * annuel tel quel ; mensuel = annuel / (12 moins les mois offerts) ; trimestriel = 3 mensualités. Arrondi au centime une
 * seule fois, sur le montant de la période (1 500 € par an, 1 mois offert : 136,36 € par mois, 409,09 € par trimestre).
 * Seule fonction de conversion : éditeur, PDF, /suivi, signature, Stripe et factures de l'ERP la partagent.
 */
export function periodPriceOfAnnual(annualCents: number, interval: string | null | undefined, annualFreeMonths: number): number {
  if (interval === "YEAR") return annualCents;
  const paidMonths = 12 - Math.min(11, Math.max(0, Math.round(annualFreeMonths) || 0));
  return Math.round((annualCents * (interval === "QUARTER" ? 3 : 1)) / paidMonths);
}

/**
 * Nom d'une prestation lu par le client (devis, produit Stripe) : sans le suffixe « (annuel) » du nom ERP d'une offre
 * annuelle. Depuis le rythme au choix (annuel, trimestriel, mensuel), il induirait en erreur (décision du 29/10/2026).
 */
export function clientServiceName(name: string): string {
  return name.replace(/\s*\(annuel\)\s*$/i, "").trim();
}

/** Texte d'une ligne de devis venue du catalogue : « Nom : description », nom lu par le client. */
export function serviceLineText(svc: { name: string; description?: string | null }): string {
  const name = clientServiceName(svc.name);
  return svc.description ? `${name} : ${svc.description}` : name;
}
