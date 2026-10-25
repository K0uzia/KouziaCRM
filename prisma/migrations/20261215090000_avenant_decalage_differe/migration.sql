-- Lot E-c (audit du 25/10/2026), additive.
-- Ligne d'avenant d'un devis signé sans décalage de l'échéance : le décalage se fait à la conversion en facture, une fois.
-- Défaut false : un devis signé avant (décalé à la signature) n'est jamais décalé une seconde fois.
ALTER TABLE "InvoiceLine" ADD COLUMN "revisionShiftDeferred" BOOLEAN NOT NULL DEFAULT false;
