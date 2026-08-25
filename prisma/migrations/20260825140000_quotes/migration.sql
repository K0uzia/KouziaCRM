-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "number" TEXT,
    "documentType" TEXT NOT NULL DEFAULT 'INVOICE',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "clientId" TEXT NOT NULL,
    "clientSnapshot" JSON,
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
    "issuedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_creditedInvoiceId_fkey" FOREIGN KEY ("creditedInvoiceId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Invoice_sourceQuoteId_fkey" FOREIGN KEY ("sourceQuoteId") REFERENCES "Invoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_Invoice" (
  "id", "number", "documentType", "status", "clientId", "clientSnapshot",
  "issueDate", "dueDate", "sequenceYear", "sequenceNumber", "currency",
  "subtotalCents", "totalCents", "notes", "paymentTerms", "creditedInvoiceId",
  "issuedAt", "createdAt", "updatedAt"
)
SELECT
  "id", "number", "documentType", "status", "clientId", "clientSnapshot",
  "issueDate", "dueDate", "sequenceYear", "sequenceNumber", "currency",
  "subtotalCents", "totalCents", "notes", "paymentTerms", "creditedInvoiceId",
  "issuedAt", "createdAt", "updatedAt"
FROM "Invoice";

DROP TABLE "Invoice";
ALTER TABLE "new_Invoice" RENAME TO "Invoice";

CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");
CREATE INDEX "Invoice_clientId_idx" ON "Invoice"("clientId");
CREATE INDEX "Invoice_issueDate_idx" ON "Invoice"("issueDate");
CREATE INDEX "Invoice_documentType_idx" ON "Invoice"("documentType");
CREATE UNIQUE INDEX "Invoice_sequenceYear_sequenceNumber_documentType_key" ON "Invoice"("sequenceYear", "sequenceNumber", "documentType");

CREATE TABLE "QuoteSequence" (
    "year" INTEGER NOT NULL PRIMARY KEY,
    "lastNumber" INTEGER NOT NULL DEFAULT 0
);

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
