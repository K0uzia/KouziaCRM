-- CreateEnum
-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revolutId" TEXT NOT NULL,
    "bookedAt" DATETIME NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "counterpartyName" TEXT,
    "counterpartyIban" TEXT,
    "reference" TEXT,
    "revolutState" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "ignoreCategory" TEXT,
    "matchedInvoiceId" TEXT,
    "paymentId" TEXT,
    "suggestionsJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BankTransaction_matchedInvoiceId_fkey" FOREIGN KEY ("matchedInvoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BankTransaction_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "BankTransaction_revolutId_key" ON "BankTransaction"("revolutId");
CREATE UNIQUE INDEX "BankTransaction_paymentId_key" ON "BankTransaction"("paymentId");
CREATE INDEX "BankTransaction_status_idx" ON "BankTransaction"("status");
CREATE INDEX "BankTransaction_bookedAt_idx" ON "BankTransaction"("bookedAt");
CREATE INDEX "BankTransaction_amountCents_idx" ON "BankTransaction"("amountCents");
CREATE INDEX "BankTransaction_matchedInvoiceId_idx" ON "BankTransaction"("matchedInvoiceId");

CREATE TABLE "BankSyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "matchedAuto" INTEGER NOT NULL DEFAULT 0,
    "unmatched" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "BankSyncLog_startedAt_idx" ON "BankSyncLog"("startedAt");

CREATE TABLE "RevolutBeneficiary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "nameEncrypted" TEXT NOT NULL,
    "ibanEncrypted" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "SalaryPayout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "revolutDraftId" TEXT,
    "beneficiaryId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SalaryPayout_beneficiaryId_fkey" FOREIGN KEY ("beneficiaryId") REFERENCES "RevolutBeneficiary" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "SalaryPayout_status_idx" ON "SalaryPayout"("status");
CREATE INDEX "SalaryPayout_createdAt_idx" ON "SalaryPayout"("createdAt");

-- RedefineTables Payment (invoiceId optional)
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "paidAt" DATETIME NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'BANK_TRANSFER',
    "reference" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "new_Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Payment" ("id", "invoiceId", "amountCents", "paidAt", "method", "reference", "notes", "createdAt")
SELECT "id", "invoiceId", "amountCents", "paidAt", "method", "reference", "notes", "createdAt" FROM "Payment";
DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");
CREATE INDEX "Payment_paidAt_idx" ON "Payment"("paidAt");

-- Subscription collectionMethod
ALTER TABLE "Subscription" ADD COLUMN "collectionMethod" TEXT NOT NULL DEFAULT 'MANUAL_TRANSFER';
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
