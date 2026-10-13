-- Reçu de paiement : PDF archivé par règlement (fichier sous data/uploads et empreinte SHA-256), additif.
ALTER TABLE "Payment" ADD COLUMN "receiptPdfPath" TEXT;
ALTER TABLE "Payment" ADD COLUMN "receiptPdfSha256" TEXT;
ALTER TABLE "Payment" ADD COLUMN "receiptArchivedAt" DATETIME;
