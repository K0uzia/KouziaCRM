-- Rapprochement Stripe : remboursements et litiges par paiement, retenues par versement (additif).
ALTER TABLE "Payment" ADD COLUMN "refundedCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Payment" ADD COLUMN "disputedCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StripePayout" ADD COLUMN "deductionsCents" INTEGER;
