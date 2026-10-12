-- Versements Stripe demandés depuis l'ERP : auteur, date et motif d'échec (colonnes additives).
ALTER TABLE "StripePayout" ADD COLUMN "requestedByEmail" TEXT;
ALTER TABLE "StripePayout" ADD COLUMN "requestedAt" DATETIME;
ALTER TABLE "StripePayout" ADD COLUMN "failureMessage" TEXT;
