-- Mentions obligatoires manquantes : date de prestation, bon de commande, escompte.
-- ALTER TABLE ADD COLUMN : pas de recréation de table.
ALTER TABLE "Invoice" ADD COLUMN "serviceDate" DATETIME;
ALTER TABLE "Invoice" ADD COLUMN "purchaseOrderRef" TEXT;
ALTER TABLE "CompanySettings" ADD COLUMN "earlyPaymentDiscountText" TEXT NOT NULL DEFAULT 'Escompte pour paiement anticipé : néant';
