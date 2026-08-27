-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN "isSubscription" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "InvoiceLine" ADD COLUMN "billingDay" INTEGER;
ALTER TABLE "InvoiceLine" ADD COLUMN "serviceId" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "subscriptionId" TEXT;

-- CreateIndex
CREATE INDEX "InvoiceLine_serviceId_idx" ON "InvoiceLine"("serviceId");
CREATE INDEX "InvoiceLine_subscriptionId_idx" ON "InvoiceLine"("subscriptionId");
