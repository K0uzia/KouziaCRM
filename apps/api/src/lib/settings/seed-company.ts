import type { PrismaClient } from "@prisma/client";

/** Valeurs de la première création (base neuve) : réglables ensuite dans l'ERP. */
export const INITIAL_COMPANY_SETTINGS = {
  legalName: "Alexandre Kouziaeff",
  tradeName: "Kouzia",
  siren: "108580028",
  siret: "10858002800018",
  apeCode: "6201Z",
  addressLine1: "13 Le Petit Moulin",
  postalCode: "29690",
  city: "Huelgoat",
  country: "FRANCE",
  website: "kouzia.com",
  vatRegime: "FRANCHISE_BASE_293B",
  vatMention: "TVA non applicable, art. 293 B du CGI",
  treasuryRateBps: 1420,
  placementRateBps: 1000,
  urssafPeriodicity: "MONTHLY",
  urssafDeadlineDay: 5,
  publicodesRegime: "AE_BNC_LIBERAL",
  paymentConditions: "Paiement à réception",
  reminderQuoteDays: 7,
  reminderInvoiceDays: 7,
  publicTrackingShowAmounts: true,
  cfeAmountCents: 25000,
  b2cActivity: true,
  incomeTaxReminderMonth: 4,
  incomeTaxReminderDay: 15,
  email: "contact@kouzia.com",
  legalForm: "EI",
  // Explicites : les DEFAULT SQL des migrations valent encore l'ancienne répartition (3 acomptes).
  depositCount: 2,
  depositPercent1Bps: 3000,
  depositPercent2Bps: 7000,
  depositPercent3Bps: 0,
} as const;

/**
 * Crée les réglages sur une base neuve. Sur une base existante (seed relancé par `kouziactl admin`),
 * ne complète que les champs vides : aucun réglage choisi dans l'ERP n'est écrasé.
 * Pas de mention de médiateur par défaut : elle n'existe qu'après adhésion (Réglages > Mentions légales).
 * @returns "created" ou "kept".
 */
export async function ensureCompanySettings(prisma: PrismaClient, now: Date = new Date()): Promise<"created" | "kept"> {
  const existing = await prisma.companySettings.findFirst();
  if (!existing) {
    await prisma.companySettings.create({ data: { ...INITIAL_COMPANY_SETTINGS, businessStartDate: now } });
    return "created";
  }
  // Ancienne répartition par défaut (3 acomptes 30/40/30), jamais choisie par l'admin : corrigée.
  const legacyThree =
    existing.depositCount === 3 &&
    existing.depositPercent1Bps === 3000 &&
    existing.depositPercent2Bps === 4000 &&
    existing.depositPercent3Bps === 3000;
  const missing = {
    ...(legacyThree ? { depositCount: 2, depositPercent2Bps: 7000, depositPercent3Bps: 0 } : {}),
    ...(existing.urssafDeadlineDay ? {} : { urssafDeadlineDay: 5 }),
    ...(existing.publicodesRegime ? {} : { publicodesRegime: "AE_BNC_LIBERAL" }),
    ...(existing.businessStartDate ? {} : { businessStartDate: now }),
  };
  if (Object.keys(missing).length > 0) {
    await prisma.companySettings.update({ where: { id: existing.id }, data: missing });
  }
  return "kept";
}
