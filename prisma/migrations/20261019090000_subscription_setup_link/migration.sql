-- Lien de prélèvement Stripe : un seul envoi automatique par abonnement (additif).
ALTER TABLE "Subscription" ADD COLUMN "setupLinkSentAt" DATETIME;
