-- Obligations administratives + settings étendus + checklist

-- AlterTable CompanySettings
ALTER TABLE "CompanySettings" ADD COLUMN "businessStartDate" DATETIME;
ALTER TABLE "CompanySettings" ADD COLUMN "cfeAmountCents" INTEGER NOT NULL DEFAULT 25000;
ALTER TABLE "CompanySettings" ADD COLUMN "b2cActivity" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CompanySettings" ADD COLUMN "incomeTaxReminderMonth" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "CompanySettings" ADD COLUMN "incomeTaxReminderDay" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "CompanySettings" ADD COLUMN "officialLinks" TEXT;

CREATE TABLE "Obligation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "dueDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "completedAt" DATETIME,
    "amountCents" INTEGER,
    "notes" TEXT,
    "label" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "Obligation_type_period_key" ON "Obligation"("type", "period");
CREATE INDEX "Obligation_status_idx" ON "Obligation"("status");
CREATE INDEX "Obligation_dueDate_idx" ON "Obligation"("dueDate");
CREATE INDEX "Obligation_type_idx" ON "Obligation"("type");

CREATE TABLE "StartupChecklist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "urssafAccount" BOOLEAN NOT NULL DEFAULT false,
    "impotsProAccount" BOOLEAN NOT NULL DEFAULT false,
    "activityQuestionnaire" BOOLEAN NOT NULL DEFAULT false,
    "cfeInitialDeclaration" BOOLEAN NOT NULL DEFAULT false,
    "rcpInsurance" BOOLEAN NOT NULL DEFAULT false,
    "mediationChecked" BOOLEAN NOT NULL DEFAULT false,
    "dedicatedBankAccount" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
