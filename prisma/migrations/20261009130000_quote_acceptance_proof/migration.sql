-- AlterTable
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "ipAddress" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "userAgent" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "pdfPath" TEXT;
ALTER TABLE "QuoteAcceptanceAudit" ADD COLUMN "pdfSha256" TEXT;
