-- Devis d'avenant : ligne qui révise un abonnement existant (ciblé par id à l'acceptation, au lieu de
-- « l'abonnement actif du client »). Colonne ajoutée sans reconstruire la table, comme subscriptionId.
ALTER TABLE "InvoiceLine" ADD COLUMN "revisesSubscriptionId" TEXT;

-- CreateIndex
CREATE INDEX "InvoiceLine_revisesSubscriptionId_idx" ON "InvoiceLine"("revisesSubscriptionId");
