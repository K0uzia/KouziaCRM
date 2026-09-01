-- Portail client, audit validation devis, paiement facture simple
ALTER TABLE "CompanySettings" ADD COLUMN "clientPortalUrl" TEXT;

ALTER TABLE "Invoice" ADD COLUMN "revolutOrderId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "checkoutUrl" TEXT;
CREATE INDEX "Invoice_revolutOrderId_idx" ON "Invoice"("revolutOrderId");

CREATE TABLE "QuoteAcceptanceAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "quoteId" TEXT NOT NULL,
    "signerName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "threadId" TEXT,
    "userId" TEXT,
    "userEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuoteAcceptanceAudit_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Invoice" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuoteAcceptanceAudit_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "EmailThread" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "QuoteAcceptanceAudit_quoteId_idx" ON "QuoteAcceptanceAudit"("quoteId");
CREATE INDEX "QuoteAcceptanceAudit_threadId_idx" ON "QuoteAcceptanceAudit"("threadId");

CREATE INDEX "EmailThread_clientId_lastMessageAt_idx" ON "EmailThread"("clientId", "lastMessageAt");
