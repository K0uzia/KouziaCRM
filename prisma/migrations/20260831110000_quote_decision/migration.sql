-- Décision du client sur un devis : horodatage, motif de refus, nom du signataire.
-- ALTER TABLE ADD COLUMN : pas de recréation de table, aucun impact sur les données existantes.
ALTER TABLE "Invoice" ADD COLUMN "quoteDecidedAt" DATETIME;
ALTER TABLE "Invoice" ADD COLUMN "quoteRejectReason" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "quoteSignerName" TEXT;
