-- Moyens de paiement (décisions du 19/10/2026) : prélèvement SEPA d'abord, virement Stripe, carte jusqu'à un seuil
-- (300 € par défaut), virement direct sur l'IBAN toujours possible. Colonnes ajoutées seulement.

-- AlterTable
ALTER TABLE "CompanySettings" ADD COLUMN "paymentSepaEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CompanySettings" ADD COLUMN "paymentCardEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "CompanySettings" ADD COLUMN "paymentCardMaxCents" INTEGER NOT NULL DEFAULT 30000;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "paymentProcessingAt" DATETIME;
ALTER TABLE "Invoice" ADD COLUMN "paymentProcessingMethod" TEXT;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodType" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "paymentMethodLast4" TEXT;
