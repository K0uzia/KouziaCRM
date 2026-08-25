-- CRM features: Counter, clientNumber, Service, milestones, QuoteStatus, reminders, settings

CREATE TABLE "Counter" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "lastValue" INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unitPriceCents" INTEGER NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'FORFAIT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "Service_active_idx" ON "Service"("active");
CREATE INDEX "Service_name_idx" ON "Service"("name");

-- Extend Client
ALTER TABLE "Client" ADD COLUMN "clientNumber" TEXT;
ALTER TABLE "Client" ADD COLUMN "accessCodeHash" TEXT;
CREATE UNIQUE INDEX "Client_clientNumber_key" ON "Client"("clientNumber");

-- Extend CompanySettings
ALTER TABLE "CompanySettings" ADD COLUMN "paymentConditions" TEXT NOT NULL DEFAULT 'Paiement à réception';
ALTER TABLE "CompanySettings" ADD COLUMN "latePenaltiesText" TEXT NOT NULL DEFAULT 'En cas de retard de paiement, une pénalité égale à 3 fois le taux d''intérêt légal sera due, ainsi qu''une indemnité forfaitaire de 40 € pour frais de recouvrement.';
ALTER TABLE "CompanySettings" ADD COLUMN "legalMentions" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "suspensionClause" TEXT NOT NULL DEFAULT 'En cas de non-paiement d''une échéance, les prestations peuvent être suspendues jusqu''à régularisation.';
ALTER TABLE "CompanySettings" ADD COLUMN "reminderQuoteDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "CompanySettings" ADD COLUMN "reminderInvoiceDays" INTEGER NOT NULL DEFAULT 7;
ALTER TABLE "CompanySettings" ADD COLUMN "publicTrackingShowAmounts" BOOLEAN NOT NULL DEFAULT false;

-- Rebuild Invoice with new columns (SQLite)
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT,
    "documentType" TEXT NOT NULL DEFAULT 'INVOICE',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "quoteStatus" TEXT,
    "clientId" TEXT NOT NULL,
    "clientSnapshot" TEXT,
    "issueDate" DATETIME,
    "dueDate" DATETIME,
    "validUntil" DATETIME,
    "sequenceYear" INTEGER,
    "sequenceNumber" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "paymentTerms" TEXT DEFAULT 'Paiement à réception',
    "creditedInvoiceId" TEXT,
    "sourceQuoteId" TEXT,
    "milestoneId" TEXT,
    "lastReminderAt" DATETIME,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "nextReminderAt" DATETIME,
    "issuedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_creditedInvoiceId_fkey" FOREIGN KEY ("creditedInvoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_sourceQuoteId_fkey" FOREIGN KEY ("sourceQuoteId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Invoice" (
  "id", "number", "documentType", "status", "quoteStatus", "clientId", "clientSnapshot",
  "issueDate", "dueDate", "validUntil", "sequenceYear", "sequenceNumber", "currency",
  "subtotalCents", "totalCents", "notes", "paymentTerms", "creditedInvoiceId",
  "sourceQuoteId", "lastReminderAt", "reminderCount", "nextReminderAt",
  "issuedAt", "createdAt", "updatedAt"
)
SELECT
  "id", "number", "documentType", "status",
  CASE
    WHEN "documentType" = 'QUOTE' AND "status" = 'DRAFT' THEN 'DRAFT'
    WHEN "documentType" = 'QUOTE' AND "status" = 'ISSUED' THEN 'SENT'
    WHEN "documentType" = 'QUOTE' AND "status" = 'PAID' THEN 'ACCEPTED'
    WHEN "documentType" = 'QUOTE' AND "status" = 'CANCELLED' THEN 'REJECTED'
    ELSE NULL
  END,
  "clientId", "clientSnapshot",
  "issueDate", "dueDate", "validUntil", "sequenceYear", "sequenceNumber", "currency",
  "subtotalCents", "totalCents", "notes", "paymentTerms", "creditedInvoiceId",
  "sourceQuoteId", NULL, 0, NULL,
  "issuedAt", "createdAt", "updatedAt"
FROM "Invoice";

DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";

CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE UNIQUE INDEX "Invoice_milestoneId_key" ON "Invoice"("milestoneId");
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");
CREATE INDEX "Invoice_clientId_idx" ON "Invoice"("clientId");
CREATE INDEX "Invoice_issueDate_idx" ON "Invoice"("issueDate");
CREATE INDEX "Invoice_documentType_idx" ON "Invoice"("documentType");
CREATE INDEX "Invoice_quoteStatus_idx" ON "Invoice"("quoteStatus");
CREATE INDEX "Invoice_nextReminderAt_idx" ON "Invoice"("nextReminderAt");
CREATE UNIQUE INDEX "Invoice_sequenceYear_sequenceNumber_documentType_key" ON "Invoice"("sequenceYear", "sequenceNumber", "documentType");

CREATE TABLE "PaymentMilestone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "percentBps" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "triggerText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PaymentMilestone_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PaymentMilestone_quoteId_idx" ON "PaymentMilestone"("quoteId");
CREATE INDEX "PaymentMilestone_status_idx" ON "PaymentMilestone"("status");

-- Add FK for milestoneId now that PaymentMilestone exists
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Invoice2" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT,
    "documentType" TEXT NOT NULL DEFAULT 'INVOICE',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "quoteStatus" TEXT,
    "clientId" TEXT NOT NULL,
    "clientSnapshot" TEXT,
    "issueDate" DATETIME,
    "dueDate" DATETIME,
    "validUntil" DATETIME,
    "sequenceYear" INTEGER,
    "sequenceNumber" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "paymentTerms" TEXT DEFAULT 'Paiement à réception',
    "creditedInvoiceId" TEXT,
    "sourceQuoteId" TEXT,
    "milestoneId" TEXT,
    "lastReminderAt" DATETIME,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "nextReminderAt" DATETIME,
    "issuedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_creditedInvoiceId_fkey" FOREIGN KEY ("creditedInvoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_sourceQuoteId_fkey" FOREIGN KEY ("sourceQuoteId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "PaymentMilestone" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Invoice2" SELECT * FROM "Invoice";
DROP TABLE "Invoice";
ALTER TABLE "new_Invoice2" RENAME TO "Invoice";

CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE UNIQUE INDEX "Invoice_milestoneId_key" ON "Invoice"("milestoneId");
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");
CREATE INDEX "Invoice_clientId_idx" ON "Invoice"("clientId");
CREATE INDEX "Invoice_issueDate_idx" ON "Invoice"("issueDate");
CREATE INDEX "Invoice_documentType_idx" ON "Invoice"("documentType");
CREATE INDEX "Invoice_quoteStatus_idx" ON "Invoice"("quoteStatus");
CREATE INDEX "Invoice_nextReminderAt_idx" ON "Invoice"("nextReminderAt");
CREATE UNIQUE INDEX "Invoice_sequenceYear_sequenceNumber_documentType_key" ON "Invoice"("sequenceYear", "sequenceNumber", "documentType");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
