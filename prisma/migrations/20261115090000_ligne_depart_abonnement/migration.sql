-- Départ de la facturation d'une ligne d'abonnement de devis : NULL = comportement actuel (signature pour un abonnement seul, livraison pour un projet).
ALTER TABLE "InvoiceLine" ADD COLUMN "subscriptionStart" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "subscriptionStartDate" DATETIME;
ALTER TABLE "InvoiceLine" ADD COLUMN "subscriptionFreeMonths" INTEGER;
