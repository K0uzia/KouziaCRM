-- Webhook Stripe (décision du 27/10/2026), additive : la ligne de l'événement est réservée au début du traitement
-- (PROCESSING, contrainte unique eventId) puis marquée DONE ; une livraison simultanée ne renvoie ni e-mail ni alerte.
-- Les lignes existantes, déjà traitées, restent DONE.
ALTER TABLE "StripeWebhookEvent" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DONE';
ALTER TABLE "StripeWebhookEvent" ADD COLUMN "claimedAt" DATETIME;
