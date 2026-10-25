-- Lot R1 (26/10/2026), additive : remise sur les premières échéances d'un devis récurrent, copiée sur l'abonnement.
-- Défauts : aucune remise ; un devis ou un abonnement existant ne change pas.
ALTER TABLE "Invoice" ADD COLUMN "recurringDiscountKind" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "recurringDiscountValue" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "recurringDiscountMonths" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "openingDiscount" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Subscription" ADD COLUMN "discountKind" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "discountValue" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "discountPeriods" INTEGER;
ALTER TABLE "Subscription" ADD COLUMN "discountPeriodsBilled" INTEGER NOT NULL DEFAULT 0;
