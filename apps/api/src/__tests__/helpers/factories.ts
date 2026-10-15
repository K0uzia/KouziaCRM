import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma.js";
import { invalidateCompanySettingsCache } from "@/lib/company.js";

export async function seedCompanySettings(): Promise<void> {
  invalidateCompanySettingsCache();
  const data = {
    legalName: "Test SARL",
    tradeName: "Test",
    siren: "000000000",
    siret: "00000000000000",
    apeCode: "6201Z",
    addressLine1: "1 rue Test",
    postalCode: "29000",
    city: "Quimper",
    country: "FRANCE",
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
    publicTrackingShowAmounts: false,
    businessStartDate: new Date(),
    cfeAmountCents: 25000,
    b2cActivity: false,
    incomeTaxReminderMonth: 4,
    incomeTaxReminderDay: 15,
    depositCount: 2,
    depositPercent1Bps: 3000,
    depositPercent2Bps: 7000,
    depositPercent3Bps: 0,
    // Médiateur déclaré : un devis à un particulier peut partir en signature (L612-1).
    mediationClause: "Médiateur de test, https://mediateur.exemple.test",
  } satisfies Prisma.CompanySettingsCreateInput;
  // Ligne recréée : les champs non listés reprennent leur valeur par défaut du schéma,
  // un test ne peut plus hériter d'un réglage modifié par un autre.
  await prisma.$transaction([prisma.companySettings.deleteMany(), prisma.companySettings.create({ data })]);
  invalidateCompanySettingsCache();
}

export async function createClient(opts: {
  displayName?: string;
  type?: "B2B" | "B2C";
} = {}): Promise<{ id: string; displayName: string }> {
  const created = await prisma.client.create({
    data: {
      displayName: opts.displayName ?? "Client Test",
      type: opts.type ?? "B2B",
    },
  });
  return created;
}

export async function createService(opts: {
  name?: string;
  unitPriceCents?: number;
  isSubscription?: boolean;
  defaultBillingDay?: number;
} = {}): Promise<{ id: string; name: string }> {
  return prisma.service.create({
    data: {
      name: opts.name ?? "Maintenance mensuelle",
      unitPriceCents: opts.unitPriceCents ?? 30000,
      isSubscription: opts.isSubscription ?? true,
      defaultBillingDay: opts.defaultBillingDay ?? 1,
    },
  });
}

export { prisma };
