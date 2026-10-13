-- Espace client /suivi : demande de résiliation (abonnement par virement) et jeton court des liens d'e-mail (additif).
ALTER TABLE "Subscription" ADD COLUMN "cancellationRequestedAt" DATETIME;
ALTER TABLE "Subscription" ADD COLUMN "publicToken" TEXT;
CREATE UNIQUE INDEX "Subscription_publicToken_key" ON "Subscription"("publicToken");
