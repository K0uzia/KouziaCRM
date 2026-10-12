-- Mode Stripe (live ou test) de chaque identifiant enregistré, et mode de la clé : garde-fous contre un changement de clé (colonnes additives).
-- Les identifiants déjà présents sont complétés au démarrage selon le mode de la clé configurée (backfillStripeModes).
ALTER TABLE "Service" ADD COLUMN "stripeLivemode" BOOLEAN;
ALTER TABLE "Subscription" ADD COLUMN "stripeLivemode" BOOLEAN;
ALTER TABLE "Client" ADD COLUMN "stripeCustomerLivemode" BOOLEAN;
ALTER TABLE "CompanySettings" ADD COLUMN "stripeKeyMode" TEXT;
