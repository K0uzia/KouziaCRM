-- Abonnements : changement d'état décidé côté Stripe (résiliation, impayés, pause), pour la notification (colonnes additives).
ALTER TABLE "Subscription" ADD COLUMN "stripeStatusChange" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "stripeStatusChangedAt" DATETIME;
