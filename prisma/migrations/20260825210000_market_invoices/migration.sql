-- Facturation marché : InvoiceType, quoteId, marketTotalCents, PaymentMilestone.invoiceId

-- Backfill invoiceType / quoteId / marketTotal après ALTER
ALTER TABLE "Invoice" ADD COLUMN "invoiceType" TEXT NOT NULL DEFAULT 'SIMPLE';
ALTER TABLE "Invoice" ADD COLUMN "quoteId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "marketTotalCents" INTEGER;
ALTER TABLE "PaymentMilestone" ADD COLUMN "invoiceId" TEXT;

-- Reprise : factures liées à un devis via sourceQuoteId ou milestone
UPDATE "Invoice"
SET "quoteId" = "sourceQuoteId"
WHERE "sourceQuoteId" IS NOT NULL AND "quoteId" IS NULL;

UPDATE "Invoice"
SET "invoiceType" = 'ACOMPTE'
WHERE "milestoneId" IS NOT NULL
  AND "documentType" = 'INVOICE'
  AND "invoiceType" = 'SIMPLE';

UPDATE "Invoice"
SET "marketTotalCents" = (
  SELECT q."totalCents" FROM "Invoice" q WHERE q."id" = "Invoice"."quoteId"
)
WHERE "quoteId" IS NOT NULL
  AND "documentType" = 'INVOICE'
  AND "marketTotalCents" IS NULL;

-- Sync jalon.invoiceId depuis Invoice.milestoneId
UPDATE "PaymentMilestone"
SET "invoiceId" = (
  SELECT i."id" FROM "Invoice" i WHERE i."milestoneId" = "PaymentMilestone"."id" LIMIT 1
)
WHERE "invoiceId" IS NULL;

CREATE INDEX "Invoice_invoiceType_idx" ON "Invoice"("invoiceType");
CREATE INDEX "Invoice_quoteId_idx" ON "Invoice"("quoteId");
CREATE INDEX "PaymentMilestone_invoiceId_idx" ON "PaymentMilestone"("invoiceId");
