-- Relances d'abonnement pilotées par Stripe et rappel annuel de non-reconduction (additif).
ALTER TABLE "CompanySettings" ADD COLUMN "nonRenewalNoticeDays" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Subscription" ADD COLUMN "stripeStatus" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "stripeCancelAt" DATETIME;
ALTER TABLE "Invoice" ADD COLUMN "stripeFailureNotifiedAttempt" INTEGER;
ALTER TABLE "Invoice" ADD COLUMN "stripeRecoveryNotifiedAt" DATETIME;
ALTER TABLE "Invoice" ADD COLUMN "stripeUncollectibleAt" DATETIME;
-- Factures miroir Stripe émises avant ce lot : plus de relance de l'ERP (Stripe retente, l'ERP écrit sur échec).
UPDATE "Invoice" SET "nextReminderAt" = NULL WHERE "stripeInvoiceId" IS NOT NULL;
-- Confirmation de paiement (3DS) et carte qui expire : e-mails envoyés par l'ERP.
ALTER TABLE "Invoice" ADD COLUMN "stripeActionRequiredAt" DATETIME;
ALTER TABLE "Invoice" ADD COLUMN "stripeActionReminderCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Invoice" ADD COLUMN "stripeActionUrl" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "cardCheckedAt" DATETIME;
ALTER TABLE "Subscription" ADD COLUMN "cardExpiryNoticeFor" TEXT;
