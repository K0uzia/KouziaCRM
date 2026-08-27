-- AlterTable
ALTER TABLE "Service" ADD COLUMN "isSubscription" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Service" ADD COLUMN "defaultBillingDay" INTEGER NOT NULL DEFAULT 1;
