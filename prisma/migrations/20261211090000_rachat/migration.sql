-- Rachat du site en fin d'engagement (lots R1 à R3). Migration additive : aucune offre n'a de prestation de rachat,
-- aucun document n'en rachète, aucun transfert n'est noté.
ALTER TABLE "Service" ADD COLUMN "buyoutServiceId" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "buysOutSubscriptionId" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "transferredAt" DATETIME;
CREATE INDEX "Invoice_buysOutSubscriptionId_idx" ON "Invoice"("buysOutSubscriptionId");
