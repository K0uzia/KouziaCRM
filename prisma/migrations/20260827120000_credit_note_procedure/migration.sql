-- AlterTable Invoice : métadonnées procédure avoir
ALTER TABLE "Invoice" ADD COLUMN "creditReason" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "creditReasonDetail" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "refundMethod" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "cgvDepositRefundable" BOOLEAN;
ALTER TABLE "Invoice" ADD COLUMN "creditFollowUp" TEXT;
