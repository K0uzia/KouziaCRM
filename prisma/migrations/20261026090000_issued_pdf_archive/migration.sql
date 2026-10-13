-- PDF des factures et avoirs émis archivé (fichier sous data/uploads et empreinte SHA-256), additif.
ALTER TABLE "Invoice" ADD COLUMN "pdfPath" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "pdfSha256" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "pdfArchivedAt" DATETIME;
