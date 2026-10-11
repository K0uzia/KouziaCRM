-- Paiement en 2 ou 3 fois : réglages, offre par devis, formule retenue, étape déclencheuse.
ALTER TABLE "CompanySettings" ADD COLUMN "split3Percent1Bps" INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE "CompanySettings" ADD COLUMN "split3Percent2Bps" INTEGER NOT NULL DEFAULT 4000;
ALTER TABLE "CompanySettings" ADD COLUMN "split3Percent3Bps" INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE "CompanySettings" ADD COLUMN "split3MinTotalCents" INTEGER NOT NULL DEFAULT 50000;
ALTER TABLE "CompanySettings" ADD COLUMN "paymentChoiceDefault" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CompanySettings" ADD COLUMN "split3Step2TriggerText" TEXT NOT NULL DEFAULT 'À la validation de l''étape définie dans le suivi de projet';
ALTER TABLE "Invoice" ADD COLUMN "paymentPlanOffer" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "paymentPlan" TEXT;
ALTER TABLE "PaymentMilestone" ADD COLUMN "triggerStepLabel" TEXT;
ALTER TABLE "PaymentMilestone" ADD COLUMN "triggeredAt" DATETIME;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "paymentPlan" TEXT;
