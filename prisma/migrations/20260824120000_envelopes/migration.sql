-- RedefineTables
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
    "urssafRateBps" INTEGER NOT NULL DEFAULT 2130,
    "treasuryRateBps" INTEGER NOT NULL DEFAULT 1420,
    "publicodesRegime" TEXT NOT NULL DEFAULT 'AE_BNC_LIBERAL',
    "invoicePrefix" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_CompanySettings" ("addressLine1", "addressLine2", "apeCode", "city", "country", "createdAt", "email", "id", "invoicePrefix", "legalName", "phone", "postalCode", "siren", "siret", "tradeName", "updatedAt", "urssafRateBps", "vatMention", "vatRegime", "website") SELECT "addressLine1", "addressLine2", "apeCode", "city", "country", "createdAt", "email", "id", "invoicePrefix", "legalName", "phone", "postalCode", "siren", "siret", "tradeName", "updatedAt", "urssafRateBps", "vatMention", "vatRegime", "website" FROM "CompanySettings";
DROP TABLE "CompanySettings";
ALTER TABLE "new_CompanySettings" RENAME TO "CompanySettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

