-- Rythme de paiement au choix du client (décision du 28/10/2026) : rythmes proposés sur le devis et sur chaque
-- proposition, rythme retenu et montant d'une échéance figés dans la preuve de signature. Colonnes ajoutées, nullables.
ALTER TABLE "Invoice" ADD COLUMN "offeredIntervals" TEXT;
ALTER TABLE "QuoteOption" ADD COLUMN "offeredIntervals" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "billingInterval" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "billingPeriodCents" INTEGER;
