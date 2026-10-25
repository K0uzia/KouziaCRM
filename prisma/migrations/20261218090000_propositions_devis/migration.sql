-- Lot P1 (27/10/2026), additive : devis à 2 propositions. Un devis sans proposition reste inchangé ; aucun rétro-remplissage.
CREATE TABLE "QuoteOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "billingMode" TEXT NOT NULL,
    "paymentPlanOffer" TEXT,
    "discountType" TEXT NOT NULL DEFAULT 'NONE',
    "discountValue" INTEGER NOT NULL DEFAULT 0,
    "recurringDiscountKind" TEXT,
    "recurringDiscountValue" INTEGER,
    "recurringDiscountMonths" INTEGER,
    "openingDiscount" BOOLEAN NOT NULL DEFAULT false,
    "promoCodeId" TEXT,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "depositBaseCents" INTEGER,
    "legalClausesSnapshot" TEXT,
    "paymentScheduleSnapshot" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "QuoteOption_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuoteOption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "QuoteOption_quoteId_position_key" ON "QuoteOption"("quoteId", "position");
CREATE INDEX "QuoteOption_promoCodeId_idx" ON "QuoteOption"("promoCodeId");

-- Liens ajoutés après coup : la colonne porte la référence, comme Invoice.promoCodeId (20261217090000).
ALTER TABLE "InvoiceLine" ADD COLUMN "optionId" TEXT REFERENCES "QuoteOption" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "InvoiceLine_optionId_idx" ON "InvoiceLine"("optionId");
ALTER TABLE "Invoice" ADD COLUMN "selectedOptionId" TEXT REFERENCES "QuoteOption" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preuve de signature : copie de la proposition retenue, jamais modifiée.
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "optionId" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "optionLabel" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "optionTotalCents" INTEGER;
