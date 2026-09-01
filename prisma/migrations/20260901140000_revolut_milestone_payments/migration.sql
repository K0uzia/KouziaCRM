-- AlterTable PaymentMilestone: champs Revolut + échéance + paiement manuel
ALTER TABLE "PaymentMilestone" ADD COLUMN "dueDate" DATETIME;
ALTER TABLE "PaymentMilestone" ADD COLUMN "revolutOrderId" TEXT;
ALTER TABLE "PaymentMilestone" ADD COLUMN "revolutPaymentId" TEXT;
ALTER TABLE "PaymentMilestone" ADD COLUMN "checkoutUrl" TEXT;
ALTER TABLE "PaymentMilestone" ADD COLUMN "paidAt" DATETIME;
ALTER TABLE "PaymentMilestone" ADD COLUMN "manualReference" TEXT;
ALTER TABLE "PaymentMilestone" ADD COLUMN "manualNotes" TEXT;
ALTER TABLE "PaymentMilestone" ADD COLUMN "paymentMethod" TEXT;

CREATE INDEX "PaymentMilestone_dueDate_idx" ON "PaymentMilestone"("dueDate");
CREATE INDEX "PaymentMilestone_revolutOrderId_idx" ON "PaymentMilestone"("revolutOrderId");

-- CreateTable RevolutWebhookEvent
CREATE TABLE "RevolutWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "milestoneId" TEXT,
    CONSTRAINT "RevolutWebhookEvent_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "PaymentMilestone" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RevolutWebhookEvent_eventId_key" ON "RevolutWebhookEvent"("eventId");
CREATE INDEX "RevolutWebhookEvent_milestoneId_idx" ON "RevolutWebhookEvent"("milestoneId");
CREATE INDEX "RevolutWebhookEvent_eventType_idx" ON "RevolutWebhookEvent"("eventType");
