-- Retire CompanySettings.urssafRateBps : taux budgétaire figé (21,30 %) devenu
-- inerte. Les cotisations sont calculées par Publicodes (modele-social) dans
-- cashflow-service.ts, la colonne n'alimentait plus aucun calcul et affichait
-- une provision inférieure à la dette réelle.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CompanySettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "siren" TEXT NOT NULL,
    "siret" TEXT NOT NULL,
    "apeCode" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "postalCode" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'FRANCE',
    "email" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "vatRegime" TEXT NOT NULL DEFAULT 'FRANCHISE_BASE_293B',
    "vatMention" TEXT NOT NULL DEFAULT 'TVA non applicable, art. 293 B du CGI',
    "treasuryRateBps" INTEGER NOT NULL DEFAULT 1420,
    "placementRateBps" INTEGER NOT NULL DEFAULT 1000,
    "urssafPeriodicity" TEXT NOT NULL DEFAULT 'MONTHLY',
    "urssafDeadlineDay" INTEGER NOT NULL DEFAULT 15,
    "publicodesRegime" TEXT NOT NULL DEFAULT 'AE_BNC_LIBERAL',
    "invoicePrefix" TEXT NOT NULL DEFAULT '',
    "invoiceNumberTemplate" TEXT NOT NULL DEFAULT 'F-{year}-{counter}',
    "quoteNumberTemplate" TEXT NOT NULL DEFAULT 'D-{year}-{counter}',
    "creditNoteNumberTemplate" TEXT NOT NULL DEFAULT 'A-{year}-{counter}',
    "numberCounterWidth" INTEGER NOT NULL DEFAULT 4,
    "numberingLegacyStarts" JSONB,
    "paymentConditions" TEXT NOT NULL DEFAULT 'Paiement à réception',
    "latePenaltiesText" TEXT NOT NULL DEFAULT 'En cas de retard de paiement, une pénalité égale à 3 fois le taux d''intérêt légal sera due, ainsi qu''une indemnité forfaitaire de 40 € pour frais de recouvrement.',
    "legalMentions" TEXT,
    "suspensionClause" TEXT NOT NULL DEFAULT 'En cas de non-paiement d''une échéance, les prestations peuvent être suspendues jusqu''à régularisation.',
    "reminderQuoteDays" INTEGER NOT NULL DEFAULT 7,
    "reminderInvoiceDays" INTEGER NOT NULL DEFAULT 7,
    "publicTrackingShowAmounts" BOOLEAN NOT NULL DEFAULT false,
    "businessStartDate" DATETIME,
    "cfeAmountCents" INTEGER NOT NULL DEFAULT 25000,
    "b2cActivity" BOOLEAN NOT NULL DEFAULT false,
    "mediationClause" TEXT,
    "incomeTaxReminderMonth" INTEGER NOT NULL DEFAULT 4,
    "incomeTaxReminderDay" INTEGER NOT NULL DEFAULT 15,
    "officialLinks" JSONB,
    "inpiUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CompanySettings" ("addressLine1", "addressLine2", "apeCode", "b2cActivity", "businessStartDate", "cfeAmountCents", "city", "country", "createdAt", "creditNoteNumberTemplate", "email", "id", "incomeTaxReminderDay", "incomeTaxReminderMonth", "inpiUrl", "invoiceNumberTemplate", "invoicePrefix", "latePenaltiesText", "legalMentions", "legalName", "mediationClause", "numberCounterWidth", "numberingLegacyStarts", "officialLinks", "paymentConditions", "phone", "placementRateBps", "postalCode", "publicTrackingShowAmounts", "publicodesRegime", "quoteNumberTemplate", "reminderInvoiceDays", "reminderQuoteDays", "siren", "siret", "suspensionClause", "tradeName", "treasuryRateBps", "updatedAt", "urssafDeadlineDay", "urssafPeriodicity", "vatMention", "vatRegime", "website") SELECT "addressLine1", "addressLine2", "apeCode", "b2cActivity", "businessStartDate", "cfeAmountCents", "city", "country", "createdAt", "creditNoteNumberTemplate", "email", "id", "incomeTaxReminderDay", "incomeTaxReminderMonth", "inpiUrl", "invoiceNumberTemplate", "invoicePrefix", "latePenaltiesText", "legalMentions", "legalName", "mediationClause", "numberCounterWidth", "numberingLegacyStarts", "officialLinks", "paymentConditions", "phone", "placementRateBps", "postalCode", "publicTrackingShowAmounts", "publicodesRegime", "quoteNumberTemplate", "reminderInvoiceDays", "reminderQuoteDays", "siren", "siret", "suspensionClause", "tradeName", "treasuryRateBps", "updatedAt", "urssafDeadlineDay", "urssafPeriodicity", "vatMention", "vatRegime", "website" FROM "CompanySettings";
DROP TABLE "CompanySettings";
ALTER TABLE "new_CompanySettings" RENAME TO "CompanySettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
