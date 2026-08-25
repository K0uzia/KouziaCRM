-- Numérotation multi-documents conforme CGI art. 242 nonies
-- Counter clients → NamedCounter ; Counter documents (type, année) ; templates Settings

-- 1. Compteur clients (ex-Counter name/lastValue)
CREATE TABLE "NamedCounter" (
    "name" TEXT NOT NULL PRIMARY KEY,
    "lastValue" INTEGER NOT NULL DEFAULT 0
);

INSERT INTO "NamedCounter" ("name", "lastValue")
SELECT "name", "lastValue" FROM "Counter";

DROP TABLE "Counter";

-- 2. Compteur documents légaux
CREATE TABLE "Counter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentType" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX "Counter_documentType_year_key" ON "Counter"("documentType", "year");
CREATE INDEX "Counter_documentType_idx" ON "Counter"("documentType");

-- Reprise depuis les anciennes tables de séquence + max sequenceNumber en base
INSERT INTO "Counter" ("id", "documentType", "year", "lastValue")
SELECT
  lower(hex(randomblob(8))) || lower(hex(randomblob(8))),
  'FACTURE',
  "year",
  "lastNumber"
FROM "InvoiceSequence";

INSERT INTO "Counter" ("id", "documentType", "year", "lastValue")
SELECT
  lower(hex(randomblob(8))) || lower(hex(randomblob(8))),
  'DEVIS',
  "year",
  "lastNumber"
FROM "QuoteSequence";

-- Avoirs : série distincte, initialisée au max sequenceNumber CREDIT_NOTE si existant
INSERT INTO "Counter" ("id", "documentType", "year", "lastValue")
SELECT
  lower(hex(randomblob(8))) || lower(hex(randomblob(8))),
  'AVOIR',
  "sequenceYear",
  MAX("sequenceNumber")
FROM "Invoice"
WHERE "documentType" = 'CREDIT_NOTE'
  AND "sequenceYear" IS NOT NULL
  AND "sequenceNumber" IS NOT NULL
  AND "number" IS NOT NULL
GROUP BY "sequenceYear";

DROP TABLE "InvoiceSequence";
DROP TABLE "QuoteSequence";

-- 3. Templates Settings
ALTER TABLE "CompanySettings" ADD COLUMN "invoiceNumberTemplate" TEXT NOT NULL DEFAULT 'F-{year}-{counter}';
ALTER TABLE "CompanySettings" ADD COLUMN "quoteNumberTemplate" TEXT NOT NULL DEFAULT 'D-{year}-{counter}';
ALTER TABLE "CompanySettings" ADD COLUMN "creditNoteNumberTemplate" TEXT NOT NULL DEFAULT 'A-{year}-{counter}';
ALTER TABLE "CompanySettings" ADD COLUMN "numberCounterWidth" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "CompanySettings" ADD COLUMN "numberingLegacyStarts" TEXT;
